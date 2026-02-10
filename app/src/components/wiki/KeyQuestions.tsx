import React from "react";
import { cn } from "@lib/utils";

interface Position {
  position: string;
  confidence?: string;
  reasoning?: string;
  implications?: string;
}

interface RichQuestion {
  question: string;
  positions?: Position[];
}

type QuestionItem = string | RichQuestion;

interface KeyQuestionsProps {
  questions: QuestionItem[];
  className?: string;
  "client:load"?: boolean;
}

function isRichQuestion(item: QuestionItem): item is RichQuestion {
  return typeof item === "object" && item !== null && "question" in item;
}

export function KeyQuestions({ questions, className }: KeyQuestionsProps) {
  if (!questions || questions.length === 0) return null;

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Key Questions
      </h3>
      <ul className="space-y-4">
        {questions.map((item, i) => {
          if (isRichQuestion(item)) {
            return (
              <li key={i}>
                <div className="flex gap-2.5 text-sm leading-relaxed font-medium">
                  <span className="text-muted-foreground shrink-0 mt-0.5">?</span>
                  <span>{item.question}</span>
                </div>
                {item.positions && item.positions.length > 0 && (
                  <div className="ml-6 mt-2 space-y-1.5">
                    {item.positions.map((pos, j) => (
                      <div key={j} className="text-xs border-l-2 border-muted pl-3 py-1">
                        <div className="font-medium text-foreground">{pos.position}</div>
                        {pos.reasoning && (
                          <p className="text-muted-foreground mt-0.5">{pos.reasoning}</p>
                        )}
                        {pos.implications && (
                          <p className="text-muted-foreground mt-0.5 italic">
                            → {pos.implications}
                          </p>
                        )}
                        {pos.confidence && (
                          <span className="text-[10px] text-muted-foreground">
                            Confidence: {pos.confidence}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          }

          return (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
              <span className="text-muted-foreground shrink-0 font-medium mt-0.5">?</span>
              <span>{item}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
