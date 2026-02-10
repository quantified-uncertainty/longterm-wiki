"use client";

import React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

/**
 * MDX-compatible Tabs wrapper.
 *
 * Usage in MDX:
 * <Tabs>
 *   <TabItem label="Tab 1">Content 1</TabItem>
 *   <TabItem label="Tab 2">Content 2</TabItem>
 * </Tabs>
 */

interface MdxTabItemProps {
  label: string;
  icon?: string;
  children?: React.ReactNode;
}

export function MdxTabItem({ children }: MdxTabItemProps) {
  // TabItem is a structural component — its rendering is handled by MdxTabs
  return <>{children}</>;
}

interface MdxTabsProps {
  children?: React.ReactNode;
}

export function MdxTabs({ children }: MdxTabsProps) {
  // Extract TabItem children and their labels
  const items: Array<{ label: string; content: React.ReactNode }> = [];

  React.Children.forEach(children, (child) => {
    if (React.isValidElement<MdxTabItemProps>(child) && child.props.label) {
      items.push({
        label: child.props.label,
        content: child.props.children,
      });
    }
  });

  if (items.length === 0) {
    // Fallback: render children directly if no TabItem children found
    return <div>{children}</div>;
  }

  const defaultValue = `tab-0`;

  return (
    <Tabs defaultValue={defaultValue} className="my-4">
      <TabsList>
        {items.map((item, i) => (
          <TabsTrigger key={i} value={`tab-${i}`}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item, i) => (
        <TabsContent key={i} value={`tab-${i}`}>
          {item.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
