/** Navigation link types */
export interface NavLink {
  href: string;
  label: string;
}

export interface NavDropdown {
  label: string;
  items: NavLink[];
}

export type NavItem = NavLink | NavDropdown;

export function isDropdown(item: NavItem): item is NavDropdown {
  return "items" in item;
}

/** Header navigation — mix of standalone links and grouped dropdowns. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/search", label: "Search" },
  {
    label: "Entities",
    items: [
      { href: "/organizations", label: "Organizations" },
      { href: "/people", label: "People" },
      { href: "/ai-models", label: "AI Models" },
      { href: "/projects", label: "Projects" },
      { href: "/funding-programs", label: "Funding Programs" },
    ],
  },
  {
    label: "Research",
    items: [
      { href: "/research-areas", label: "Research Areas" },
      { href: "/approaches", label: "Approaches" },
      { href: "/benchmarks", label: "Benchmarks" },
    ],
  },
  {
    label: "Policy",
    items: [
      { href: "/legislation", label: "Legislation" },
      { href: "/politicians", label: "Politicians" },
      { href: "/races", label: "Races" },
    ],
  },
  {
    label: "Sources",
    items: [
      { href: "/resources", label: "Resources" },
      { href: "/publications", label: "Publications" },
      { href: "/sourcing", label: "Source Checks" },
      { href: "/data-sources", label: "Data Sources" },
      { href: "/things", label: "Things" },
    ],
  },
  { href: "/factbase", label: "FactBase" },
  { href: "/wiki/E755", label: "About" },
  { href: "/wiki/E779", label: "Internal" },
];

/** Flat list of all nav links (for mobile nav and anywhere needing a simple list). */
export const NAV_LINKS: NavLink[] = NAV_ITEMS.flatMap((item) =>
  isDropdown(item) ? item.items : [item]
);
