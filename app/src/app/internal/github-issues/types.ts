export interface IssueRow {
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
  priority: number;
  inProgress: boolean;
}
