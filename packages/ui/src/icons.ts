/**
 * Tree-shakeable access to Lucide's complete icon catalog.
 *
 * Import named icons from `@workspace/ui/icons`; never import an all-icons map
 * or sprite. Bundlers then include only the SVG components a surface uses.
 */
export * from "lucide-react";
