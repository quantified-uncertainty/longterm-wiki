import React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface ComparisonRow {
  name: string;
  link?: string;
  values?: Record<string, string | { value: string; badge?: 'high' | 'medium' | 'low' }>;
  attributes?: Record<string, string | { value: string; badge?: 'high' | 'medium' | 'low' }>;
}

interface ComparisonTableProps {
  title: string;
  columns?: string[];
  rows?: ComparisonRow[];
  items?: ComparisonRow[];
  highlightColumn?: string;
}

const badgeVariantMap = {
  high: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  low: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800',
} as const;

export function ComparisonTable({ title, columns, rows, items, highlightColumn }: ComparisonTableProps) {
  // Use rows or items (backwards compatibility)
  const tableRows = rows || items || [];

  // Use provided columns or derive from first row
  const tableColumns = columns || (() => {
    const firstRow = tableRows[0];
    if (!firstRow) return [];
    return Object.keys(firstRow.values || firstRow.attributes || {});
  })();

  if (tableRows.length === 0) {
    return (
      <Card className="my-6">
        <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">No data available</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="my-6">
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Name</TableHead>
              {tableColumns.map(col => (
                <TableHead
                  key={col}
                  className={cn(
                    col === highlightColumn && 'bg-sky-500/10'
                  )}
                >
                  {col}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {tableRows.map((row, i) => {
              // Support both values and attributes
              const rowData = row.values || row.attributes || {};

              return (
                <TableRow key={i}>
                  <TableCell className="pl-6">
                    {row.link ? (
                      <a href={row.link} className="text-primary hover:underline">
                        {row.name}
                      </a>
                    ) : (
                      <strong>{row.name}</strong>
                    )}
                  </TableCell>
                  {tableColumns.map(col => {
                    const cellValue = rowData[col];
                    if (!cellValue) return <TableCell key={col}>—</TableCell>;

                    if (typeof cellValue === 'string') {
                      return <TableCell key={col} className="whitespace-normal">{cellValue}</TableCell>;
                    }

                    return (
                      <TableCell key={col} className="whitespace-normal">
                        <span className="flex items-center gap-2 flex-wrap">
                          {cellValue.value}
                          {cellValue.badge && (
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-xs capitalize',
                                badgeVariantMap[cellValue.badge]
                              )}
                            >
                              {cellValue.badge}
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default ComparisonTable;
