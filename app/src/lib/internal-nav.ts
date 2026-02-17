export interface NavItem {
  label: string;
  href: string;
}

export interface NavSection {
  title: string;
  defaultOpen?: boolean;
  items: NavItem[];
}
