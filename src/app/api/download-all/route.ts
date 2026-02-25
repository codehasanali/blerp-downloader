import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fetchFn from "node-fetch";
import JSZip from "jszip";

export const runtime = "nodejs";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  Referer: "https://blerp.com/",
};

type FoundMedia = {
  audioUrl?: string;
  coverStaticUrl?: string;
  coverAnimatedUrl?: string;
};

function extractMainContentThumbnailUrl(html: string): string | undefined {
  // Kullanıcının tarif ettiği ana kart alanındaki img src'yi öncelikli al.
  const blockMatch = html.match(
    /id=["']main-content["'][\s\S]*?class=["'][^"']*group\s+w-full[^"']*lg:mr-6[^"']*["'][\s\S]*?<img[^>]*src=["'](https:\/\/cdn\.blerp\.com\/thumbnails\/[^"']+)["']/i
  );
  if (blockMatch?.[1]) return blockMatch[1];

  // Bazı sayfalarda sınıf sırası değişebiliyor; daha gevşek bir fallback.
  const genericMainImg = html.match(
    /id=["']main-content["'][\s\S]*?<img[^>]*src=["'](https:\/\/cdn\.blerp\.com\/thumbnails\/[^"']+)["']/i
  );
  if (genericMainImg?.[1]) return genericMainImg[1];

  // SEO meta fallback (bazı SPA sayfalarında sadece og:image dolu oluyor).
  const ogImage = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["'](https:\/\/cdn\.blerp\.com\/thumbnails\/[^"']+)["']/i
  );
  if (ogImage?.[1]) return ogImage[1];

  return undefined;
}

function getIdFromCdnUrl(input?: string): string | null {
  if (!input) return null;
  const m = input.match(/cdn\.blerp\.com\/(?:thumbnails|normalized)\/([^?"'<>/]+)/i);
  return m?.[1] || null;
}

function buildAnimatedCandidates(found: FoundMedia): string[] {
  const candidates = new Set<string>();

  if (found.coverAnimatedUrl) candidates.add(found.coverAnimatedUrl);

  const id = getIdFromCdnUrl(found.coverStaticUrl) || getIdFromCdnUrl(found.audioUrl);
  if (!id) return Array.from(candidates);

  // Blerp CDN'de sık görülen muhtemel hareketli varyantlar
  candidates.add(`https://cdn.blerp.com/normalized/${id}`);
  candidates.add(`https://cdn.blerp.com/normalized/${id}.mp4`);
  candidates.add(`https://cdn.blerp.com/normalized/${id}.webm`);
  candidates.add(`https://cdn.blerp.com/normalized/${id}.gif`);
  candidates.add(`https://cdn.blerp.com/thumbnails/${id}.gif`);
  candidates.add(`https://cdn.blerp.com/thumbnails/${id}.webp`);

  return Array.from(candidates);
}

function getExtensionFromType(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("audio/mpeg") || lower.includes("audio/mp3")) return ".mp3";
  if (lower.includes("audio/ogg")) return ".ogg";
  if (lower.includes("audio/wav") || lower.includes("audio/x-wav")) return ".wav";
  if (lower.includes("video/mp4")) return ".mp4";
  if (lower.includes("video/webm")) return ".webm";
  if (lower.includes("image/jpeg")) return ".jpg";
  if (lower.includes("image/png")) return ".png";
  if (lower.includes("image/webp")) return ".webp";
  if (lower.includes("image/gif")) return ".gif";
  return "";
}

async function findMediaUrls(html: string): Promise<FoundMedia> {
  const result: FoundMedia = {};

  const mainThumb = extractMainContentThumbnailUrl(html);
  if (mainThumb) {
    result.coverStaticUrl = mainThumb;
  } else {
    const thumbMatch = html.match(/https:\/\/cdn\.blerp\.com\/thumbnails\/[^\s"'<>]+/i);
    if (thumbMatch?.[0]) result.coverStaticUrl = thumbMatch[0];
  }

  const allMatches = [...html.matchAll(/https:\/\/[^"'\\s]+/g)];
  const candidates = Array.from(new Set(allMatches.map((x) => x[0])));

  const skipExts = [".css", ".js", ".svg", ".woff", ".woff2"];

  for (const url of candidates) {
    if (result.audioUrl && result.coverAnimatedUrl) break;
    const lowerUrl = url.toLowerCase();
    if (skipExts.some((ext) => lowerUrl.includes(ext))) continue;

    try {
      const head = await fetchFn(url, {
        method: "HEAD",
        headers: HEADERS,
        redirect: "follow",
      });
      const ctype = (head.headers.get("content-type") || "").toLowerCase();
      const finalUrl = (head as any).url || url;

      if (!result.audioUrl && ctype.startsWith("audio/")) {
        result.audioUrl = finalUrl;
      }
      if (!result.coverAnimatedUrl && ctype.startsWith("video/")) {
        result.coverAnimatedUrl = finalUrl;
      }
      if (!result.coverStaticUrl && ctype.startsWith("image/") && !ctype.includes("gif")) {
        result.coverStaticUrl = finalUrl;
      }
      if (!result.coverAnimatedUrl && ctype.includes("image/gif")) {
        result.coverAnimatedUrl = finalUrl;
      }
    } catch {
      // ignore
    }
  }

  return result;
}

async function downloadToZip(
  zip: JSZip,
  namePrefix: string,
  mediaUrl: string | undefined
): Promise<boolean> {
  if (!mediaUrl) return false;
  try {
    const resp = await fetchFn(mediaUrl, { headers: HEADERS, redirect: "follow" });
    if (!resp.ok) return false;
    const ctype = resp.headers.get("content-type") || "application/octet-stream";
    const ext = getExtensionFromType(ctype);
    const fileName = `${namePrefix}${ext || ""}`;
    const arr = await resp.arrayBuffer();
    zip.file(fileName, Buffer.from(arr));
    return true;
  } catch {
    return false;
  }
}

async function downloadFirstWorkingToZip(
  zip: JSZip,
  namePrefix: string,
  mediaUrls: string[]
): Promise<boolean> {
  for (const url of mediaUrls) {
    const ok = await downloadToZip(zip, namePrefix, url);
    if (ok) return true;
  }
  return false;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const url = body?.url as string | undefined;

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Geçerli bir URL gönder." }, { status: 400 });
    }
    if (!url.startsWith("https://blerp.com/soundbites/")) {
      return NextResponse.json(
        { error: "Sadece Blerp soundbites URL'leri destekleniyor." },
        { status: 400 }
      );
    }

    const pageResp = await fetchFn(url, { headers: HEADERS });
    if (!pageResp.ok) {
      return NextResponse.json(
        { error: "Sayfa alınamadı.", status: pageResp.status },
        { status: pageResp.status }
      );
    }

    const html = await pageResp.text();
    const found = await findMediaUrls(html);

    const zip = new JSZip();
    const okAudio = await downloadToZip(zip, "audio", found.audioUrl);
    const okStatic = await downloadToZip(zip, "cover_static", found.coverStaticUrl);
    const animatedCandidates = buildAnimatedCandidates(found);
    const okAnimated = await downloadFirstWorkingToZip(
      zip,
      "cover_animated",
      animatedCandidates
    );

    if (!okAudio && !okStatic && !okAnimated) {
      return NextResponse.json(
        {
          error:
            "İndirilebilir medya bulunamadı. Blerp sayfası login/cors nedeniyle sunucudan engelleniyor olabilir.",
        },
        { status: 500 }
      );
    }

    zip.file(
      "README.txt",
      [
        "Blerp Downloader çıktısı",
        `audio: ${okAudio ? "ok" : "yok/engelli"}`,
        `cover_static: ${okStatic ? "ok" : "yok/engelli"}`,
        `cover_animated: ${okAnimated ? "ok" : "yok/engelli"}`,
      ].join("\n")
    );

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="blerp_bundle.zip"',
      },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Sunucu hatası." }, { status: 500 });
  }
}

