import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fetchFn from "node-fetch";

export const runtime = "nodejs";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  Referer: "https://blerp.com/",
};

type MediaKind = "audio" | "cover_static" | "cover_animated";

function extractUrlFromInput(input: string | undefined, kind: MediaKind): string {
  const raw = (input || "").trim();
  if (!raw) return "";

  if (raw.startsWith("https://")) return raw;

  // Etiket içinde geçen tüm URL'leri topla.
  const urls = Array.from(raw.matchAll(/https:\/\/[^\s"'<>]+/gi)).map((m) => m[0]);
  if (urls.length === 0) return "";

  if (kind === "cover_animated") {
    // Hareketli kapak için öncelik: gif/webm/mp4/video benzeri URL'ler.
    const animatedFirst =
      urls.find((u) => /\.(gif|webm|mp4)(\?|$)/i.test(u)) ||
      urls.find((u) => /\/video|\/videos|\/animated|\/clips/i.test(u)) ||
      urls.find((u) => /\/normalized\//i.test(u));
    if (animatedFirst) return animatedFirst;
  }

  if (kind === "cover_static") {
    const thumb = urls.find((u) => /cdn\.blerp\.com\/thumbnails\//i.test(u));
    if (thumb) return thumb;
    const imageFirst =
      urls.find((u) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u)) ||
      urls.find((u) => /\/thumbnails\//i.test(u));
    if (imageFirst) return imageFirst;
  }

  // audio ya da fallback için ilk URL
  return urls[0];
}

async function findMediaUrl(
  html: string,
  kind: MediaKind
): Promise<string | null> {
  if (kind === "cover_static") {
    // Blerp kapakları genelde uzantısız thumbnails endpoint'i ile geliyor.
    const thumbMatch = html.match(/https:\/\/cdn\.blerp\.com\/thumbnails\/[^\s"'<>]+/i);
    if (thumbMatch?.[0]) return thumbMatch[0];
  }

  // Sayfadaki tüm https:// URL'leri tara ve Content-Type'a göre gruplandır
  const allMatches = [...html.matchAll(/https:\/\/[^"'\\s]+/g)];
  const candidates = Array.from(new Set(allMatches.map((x) => x[0])));

  const skipExts = [
    ".css",
    ".js",
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".woff",
    ".woff2",
  ];

  const audio: string[] = [];
  const video: string[] = [];
  const imageStatic: string[] = [];
  const imageAnimated: string[] = [];

  for (const url of candidates) {
    const lower = url.toLowerCase();
    if (skipExts.some((ext) => lower.includes(ext))) continue;

    try {
      const head = await fetchFn(url, {
        method: "HEAD",
        headers: HEADERS,
        redirect: "follow",
      });

      const ctype = (head.headers.get("content-type") || "").toLowerCase();

      if (ctype.startsWith("audio/")) {
        audio.push((head as any).url || url);
      } else if (ctype.startsWith("video/")) {
        video.push((head as any).url || url);
      } else if (
        ctype.startsWith("image/") ||
        ctype.includes("gif") ||
        ctype.includes("webp")
      ) {
        const finalUrl = (head as any).url || url;
        if (ctype.includes("gif")) imageAnimated.push(finalUrl);
        else imageStatic.push(finalUrl);
      }
    } catch {
      // ignore and continue
    }
  }

  if (kind === "audio") {
    if (audio.length > 0) return audio[0];
    if (video.length > 0) return video[0];
  } else if (kind === "cover_static") {
    if (imageStatic.length > 0) return imageStatic[0];
    if (imageAnimated.length > 0) return imageAnimated[0];
  } else if (kind === "cover_animated") {
    if (video.length > 0) return video[0];
    if (imageAnimated.length > 0) return imageAnimated[0];
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const url = body?.url as string | undefined;
    const kind = (body?.kind as MediaKind | undefined) ?? "audio";
    const mediaUrlFromBody = body?.mediaUrl as string | undefined;

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { error: "Geçerli bir URL gönder." },
        { status: 400 }
      );
    }

    if (!url.startsWith("https://blerp.com/soundbites/")) {
      return NextResponse.json(
        { error: "Sadece Blerp soundbites URL'leri destekleniyor." },
        { status: 400 }
      );
    }

    let mediaUrl = extractUrlFromInput(mediaUrlFromBody, kind);
    if (mediaUrl && !mediaUrl.startsWith("https://")) {
      return NextResponse.json(
        { error: "Kapak CDN URL geçersiz. https:// ile başlamalı." },
        { status: 400 }
      );
    }

    if (kind === "cover_animated" && mediaUrl && /cdn\.blerp\.com\/thumbnails\//i.test(mediaUrl)) {
      // Thumbnail linki genelde statik görsel. Hareketli isteniyorsa media request URL gerekli.
      return NextResponse.json(
        {
          error:
            "Bu link statik thumbnail. Hareketli kapak için Blerp'de oynatıp Network > Media'dan mp4/webm/gif URL'sini yapıştır.",
        },
        { status: 400 }
      );
    }

    // mediaUrl gönderilmediyse, soundbite sayfasından bulmayı dene.
    if (!mediaUrl) {
      const pageResp = await fetchFn(url, { headers: HEADERS });
      if (!pageResp.ok) {
        return NextResponse.json(
          { error: "Sayfa alınamadı.", status: pageResp.status },
          { status: pageResp.status }
        );
      }
      const html = await pageResp.text();

      const detected = await findMediaUrl(html, kind);
      if (!detected) {
        return NextResponse.json(
          {
            error:
            "Medya URL'si bulunamadı. İlgili input'a doğru CDN URL yapıştır.",
          },
          { status: 500 }
        );
      }
      mediaUrl = detected;
    }

    const mediaResp = await fetchFn(mediaUrl, {
      headers: HEADERS,
      redirect: "follow",
    });
    if (!mediaResp.ok) {
      return NextResponse.json(
        { error: "Medya indirilemedi.", status: mediaResp.status },
        { status: mediaResp.status }
      );
    }

    const ctype =
      mediaResp.headers.get("content-type") || "application/octet-stream";
    if (kind === "cover_static" && ctype.startsWith("video/")) {
      return NextResponse.json(
        { error: "Bu URL hareketli kapak (video). Statik kapak URL gir." },
        { status: 400 }
      );
    }
    if (kind === "cover_animated" && ctype.startsWith("image/") && !ctype.includes("gif")) {
      return NextResponse.json(
        { error: "Bu URL statik görsel. Hareketli kapak için mp4/webm/gif URL gir." },
        { status: 400 }
      );
    }
    let filename = mediaUrl.split("/").pop()?.split("?")[0] || "blerp_sound";
    let ext = "";

    if (!filename.includes(".")) {
      const lower = ctype.toLowerCase();
      if (lower.includes("audio/mpeg") || lower.includes("audio/mp3"))
        ext = ".mp3";
      else if (lower.includes("audio/ogg")) ext = ".ogg";
      else if (lower.includes("audio/wav") || lower.includes("audio/x-wav"))
        ext = ".wav";
      else if (lower.includes("webm")) ext = ".webm";
      else if (lower.startsWith("audio/")) ext = ".audio";
      else if (lower.startsWith("video/")) ext = ".mp4";
      else if (lower.includes("image/jpeg")) ext = ".jpg";
      else if (lower.includes("image/png")) ext = ".png";
      else if (lower.includes("image/webp")) ext = ".webp";
      else if (lower.includes("image/gif")) ext = ".gif";
      else if (lower.startsWith("image/")) ext = ".img";
    }
    if (ext && !filename.endsWith(ext)) filename += ext;

    const arrayBuffer = await mediaResp.arrayBuffer();

    const res = new NextResponse(Buffer.from(arrayBuffer), {
      status: 200,
      headers: {
        "Content-Type": ctype,
        "Content-Disposition": `attachment; filename="${filename.replace(
          /"/g,
          ""
        )}"`,
      },
    });

    return res;
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Sunucu hatası." }, { status: 500 });
  }
}

