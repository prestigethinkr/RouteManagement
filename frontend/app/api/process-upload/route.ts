import { NextResponse } from "next/server";

// This API route is no longer used. All processing is now client-side (stateless).
// Kept as a stub for backward compatibility.
export async function POST() {
  return NextResponse.json(
    { detail: "This endpoint is deprecated. The app now processes files client-side." },
    { status: 410 }
  );
}
