import { ImageResponse } from "next/og";
import { getEntityById, getPageById } from "@/data";
import { numericIdToSlug } from "@/lib/mdx";

export const runtime = "nodejs";
export const alt = "Longterm Wiki";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

export default async function OgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let slug: string | null;
  if (isNumericId(id)) {
    slug = numericIdToSlug(id.toUpperCase());
  } else {
    slug = id;
  }

  const entity = slug ? getEntityById(slug) : null;
  const pageData = slug ? getPageById(slug) : null;
  const title = entity?.title || pageData?.title || slug || id;
  const description = entity?.description || pageData?.description || null;

  return new ImageResponse(
    (
      <div
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "sans-serif",
          padding: "60px 80px",
        }}
      >
        <div
          style={{
            fontSize: title.length > 40 ? 48 : 60,
            fontWeight: 700,
            color: "#f8fafc",
            marginBottom: 20,
            textAlign: "center",
            lineHeight: 1.2,
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
        {description && (
          <div
            style={{
              fontSize: 26,
              color: "#94a3b8",
              textAlign: "center",
              lineHeight: 1.4,
              maxWidth: "90%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
            }}
          >
            {description.length > 200 ? description.slice(0, 200) + "…" : description}
          </div>
        )}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            fontSize: 22,
            color: "#64748b",
          }}
        >
          Longterm Wiki
        </div>
      </div>
    ),
    { ...size },
  );
}
