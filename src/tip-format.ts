export interface TipSections {
  action: string;
  product?: string;
  current?: string;
}

export function formatTip({ action, product, current }: TipSections): string {
  const sections = [`[行动] ${action.trim()}`];
  if (product?.trim()) sections.push(`[产出] ${product.trim()}`);
  if (current?.trim()) sections.push(`[当前] ${current.trim()}`);
  return sections.join("\n\n");
}
