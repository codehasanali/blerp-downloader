import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fetchFn from "node-fetch";
import sharp from "sharp";

export const runtime = "nodejs";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  Referer: "https://blerp.com/",
};

function getExtFromContentType(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("image/jpeg")) return ".jpg";
  if (lower.includes("image/png")) return ".png";
  if (lower.includes("image/webp")) return ".webp";
  if (lower.includes("image/gif")) return ".gif";
  return "";
}

function extractYmlCoverUrl(html: string): string | null {
  // 1) main-content bloğunu al, içindeki ilk thumbnail'i seç.
  const mainBlock = html.match(/id=["']main-content["'][\s\S]*?(?:<\/main>|<\/body>)/i)?.[0];
  if (mainBlock) {
    const inMain = mainBlock.match(/https:\/\/cdn\.blerp\.com\/thumbnails\/[^\s"'<>]+/i);
    if (inMain?.[0]) return inMain[0];
  }

  // 2) Genel fallback: sayfadaki tüm thumbnail URL'lerini topla.
  const allThumbs = Array.from(
    html.matchAll(/https:\/\/cdn\.blerp\.com\/thumbnails\/[^\s"'<>]+/gi)
  ).map((m) => m[0]);

  if (allThumbs.length === 0) return null;

  // En sık geçen thumbnail genelde ana kart görseli oluyor.
  const counts = new Map<string, number>();
  for (const t of allThumbs) counts.set(t, (counts.get(t) || 0) + 1);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || allThumbs[0] || null;
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
    const coverUrl = extractYmlCoverUrl(html);
    if (!coverUrl) {
      return NextResponse.json(
        {
          error:
            "Ana kart kapak resmi bulunamadı. Blerp sayfası server tarafında farklı render edilmiş olabilir.",
        },
        { status: 500 }
      );
    }

    const coverResp = await fetchFn(coverUrl, { headers: HEADERS, redirect: "follow" });
    if (!coverResp.ok) {
      return NextResponse.json(
        { error: "Kapak indirilemedi.", status: coverResp.status },
        { status: coverResp.status }
      );
    }

    const ctype = coverResp.headers.get("content-type") || "application/octet-stream";
    let filename = coverUrl.split("/").pop()?.split("?")[0] || "yml_cover";
    const arr = await coverResp.arrayBuffer();
    const inputBuffer = Buffer.from(arr);

    // Eğer zaten GIF ise direkt döndür.
    if (ctype.toLowerCase().includes("image/gif")) {
      if (!filename.toLowerCase().endsWith(".gif")) {
        filename = filename.replace(/\.[a-z0-9]+$/i, "") + ".gif";
      }
      return new NextResponse(inputBuffer, {
        status: 200,
        headers: {
          "Content-Type": "image/gif",
          "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
        },
      });
    }

    // WebP/JPG/PNG dahil tüm kapakları gif'e çevir.
    const gifBuffer = await sharp(inputBuffer, { animated: true, failOn: "none" })
      .resize({ width: 480, withoutEnlargement: true })
      .gif({ effort: 4 })
      .toBuffer();

    filename = filename.replace(/\.[a-z0-9]+$/i, "") + ".gif";
    return new NextResponse(new Uint8Array(gifBuffer), {
      status: 200,
      headers: {
        "Content-Type": "image/gif",
        "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "GIF donusturme sirasinda hata olustu." },
      { status: 500 }
    );
  }
}

