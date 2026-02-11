import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "Longterm Wiki — AI Safety Knowledge Base";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
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
        }}
      >
        <div
          style={{
            fontSize: 72,
            fontWeight: 700,
            color: "#f8fafc",
            marginBottom: 16,
          }}
        >
          Longterm Wiki
        </div>
        <div
          style={{
            fontSize: 32,
            color: "#94a3b8",
          }}
        >
          AI Safety Knowledge Base
        </div>
      </div>
    ),
    { ...size },
  );
}
