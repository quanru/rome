import type { HTMLAttributes, ReactNode } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// A lightweight macOS-style browser frame that adapts to whatever it wraps: a
// fixed chrome bar (traffic lights + URL pill) on top, then the image at its
// natural aspect ratio — never cropped or letterboxed. The traffic-light hexes
// are iconic macOS chrome colors (illustration, not themed UI); everything else
// uses semantic tokens so the frame tracks the active theme + dark mode.

export interface SafariProps extends HTMLAttributes<HTMLDivElement> {
  url?: string;
  imageSrc?: string;
  /** Absolutely-positioned content layered over the image (e.g. a callout
   * arrow). Rendered in a `relative` wrapper sized exactly to the image, so
   * percentage offsets map directly to image coordinates. */
  overlay?: ReactNode;
}

export function Safari({ url, imageSrc, overlay, className, ...props }: SafariProps) {
  return (
    <div
      className={cn("overflow-hidden rounded-12 border border-edge bg-surface shadow-1", className)}
      {...props}
    >
      <div className="flex items-center gap-3 border-b border-border bg-surface-muted px-4 py-2">
        <div className="flex shrink-0 gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        {url && (
          <div className="mx-auto flex max-w-[78%] items-center gap-2 rounded-8 border border-border bg-surface px-3 py-1 text-aux text-muted-foreground">
            <Lock className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{url}</span>
          </div>
        )}
      </div>
      {imageSrc && (
        <div className="relative">
          <img src={imageSrc} alt="" className="block w-full" />
          {overlay}
        </div>
      )}
    </div>
  );
}
