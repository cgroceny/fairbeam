import type { LucideProps } from "lucide-solid";
import type { ViewName } from "./cameraViews";

export type CameraViewIconProps = LucideProps & { view: ViewName };

/** A compact view-cube glyph with a camera approach cue for each orthographic direction. */
export function CameraViewIcon(props: CameraViewIconProps) {
  const { view, size = 24, width, height, color, strokeWidth, ...svgProps } = props;

  if (view === "iso") {
    return (
      <svg
        {...svgProps}
        width={width ?? size}
        height={height ?? size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color ?? "currentColor"}
        stroke-width={strokeWidth ?? 1.8}
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden={svgProps["aria-hidden"] ?? true}
      >
        <path d="M12 3.4 20 7.8v8.4l-8 4.4-8-4.4V7.8l8-4.4Z" />
        <path d="m4 7.8 8 4.5 8-4.5M12 12.3v8.3" />
      </svg>
    );
  }

  const face = {
    top: "M12 4.5 18 8 12 11.5 6 8 12 4.5Z",
    bottom: "M12 11.5 18 15 12 18.5 6 15 12 11.5Z",
    front: "M6 8 12 11.5v7L6 15V8Z",
    back: "M18 8 12 11.5v7l6-3.5V8Z",
    left: "M6 8 12 11.5v7L6 15V8Z",
    right: "M18 8 12 11.5v7l6-3.5V8Z",
  }[view];

  return (
    <svg
      {...svgProps}
      width={width ?? size}
      height={height ?? size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      stroke-width={strokeWidth ?? 1.8}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={svgProps["aria-hidden"] ?? true}
    >
      <path d={face} fill="currentColor" fill-opacity="0.1" stroke="none" />
      <path d="M12 4.5 18 8v7l-6 3.5L6 15V8l6-3.5Z" />
      <path d="m6 8 6 3.5L18 8M12 11.5v7" />
      {view === "top" && <path d="M12 1.2v2.7m-1.1-1.1L12 3.9l1.1-1.1" />}
      {view === "bottom" && <path d="M12 22.8v-2.7m-1.1 1.1 1.1-1.1 1.1 1.1" />}
      {view === "front" && <path d="M1.2 22.8 4.3 19.7M2.4 19.7h1.9v1.9" />}
      {view === "back" && <path d="M22.8 1.2 19.7 4.3m0-1.9v1.9h1.9" />}
      {view === "left" && <path d="M1.2 12h3.1m-1.2-1.1 1.2 1.1-1.2 1.1" />}
      {view === "right" && <path d="M22.8 12h-3.1m1.2-1.1-1.2 1.1 1.2 1.1" />}
    </svg>
  );
}
