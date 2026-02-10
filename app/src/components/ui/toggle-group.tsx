"use client";

import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "@lib/utils";

const variantClasses: Record<string, string> = {
  default: "bg-transparent",
  outline: "border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground",
};

const sizeClasses: Record<string, string> = {
  default: "h-9 px-2 min-w-9",
  sm: "h-8 px-1.5 min-w-8",
  lg: "h-10 px-2.5 min-w-10",
};

const ToggleGroupContext = React.createContext<{
  variant?: "default" | "outline";
  size?: "default" | "sm" | "lg";
}>({});

function ToggleGroup({
  className,
  variant = "default",
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & {
  variant?: "default" | "outline";
  size?: "default" | "sm" | "lg";
}) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("flex items-center justify-center gap-1", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & {
  variant?: "default" | "outline";
  size?: "default" | "sm" | "lg";
}) {
  const context = React.useContext(ToggleGroupContext);
  const resolvedVariant = variant || context.variant || "default";
  const resolvedSize = size || context.size || "default";

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        variantClasses[resolvedVariant],
        sizeClasses[resolvedSize],
        className
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
