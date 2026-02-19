import React from "react";
import { cn } from "@lib/utils";

interface Person {
  name: string;
  role: string;
  background?: string;
}

interface KeyPeopleProps {
  people: Person[];
  className?: string;
}

export function KeyPeople({ people, className }: KeyPeopleProps) {
  if (!people || people.length === 0) return null;

  return (
    <div className={cn("my-4 grid gap-3 sm:grid-cols-2", className)}>
      {people.map((person, i) => (
        <div key={i} className="rounded-lg border p-3">
          <div className="font-medium text-sm">{person.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{person.role}</div>
          {person.background && (
            <div className="text-xs text-muted-foreground mt-1 italic">{person.background}</div>
          )}
        </div>
      ))}
    </div>
  );
}
