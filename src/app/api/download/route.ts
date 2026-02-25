import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fetchFn from "node-fetch";

export const runtime = "nodejs";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  Referer: "https://blerp.com/",
};

async function findMediaUrl(html: string): Promise<string | null> {
  // 1) Uzantılı klasik arama
  const extRegex = /https:\/\/[^"'\\s]+\.(?:mp3|wav|ogg|webm|mp4)/i;
  const m = html.match(extRegex);
  if (m) return m[0];

  // 2) Fallback: tüm https:// URL'leri tara, audio/video içereni bul
  const allMatches = [...html.matchAll(/https:\/\/[^"'\\s]+/g)];
  const candidates = Array.from(new Set(allMatches.map((x) => x[0])));

  const skipExts = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js"];

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
      if (ctype.startsWith("audio/") || ctype.startsWith("video/")) {
        return (head as any).url || url;
      }
    } catch {
      // ignore and continue
    }
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const url = body?.url as string | undefined;

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

    const pageResp = await fetchFn(url, { headers: HEADERS });
    if (!pageResp.ok) {
      return NextResponse.json(
        { error: "Sayfa alınamadı.", status: pageResp.status },
        { status: pageResp.status }
      );
    }
    const html = await pageResp.text();

    const mediaUrl = await findMediaUrl(html);
    if (!mediaUrl) {
      return NextResponse.json(
        {
          error:
            "Medya URL'si bulunamadı. Blerp sayfa yapısı değişmiş olabilir.",
        },
        { status: 500 }
      );
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

