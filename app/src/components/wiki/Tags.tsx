import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@lib/utils";

interface TagsProps {
  tags: string[];
  className?: string;
}

export function Tags({ tags, className }: TagsProps) {
  if (!tags || tags.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1.5 my-3", className)}>
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary">
          {tag}
        </Badge>
      ))}
    </div>
  );
}
