import { roleColorVar, roleLabel } from "@/lib/format";

export function RoleBadge({ role }: { role: string }) {
  const color = roleColorVar(role);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ color, borderColor: `color-mix(in oklch, ${color} 40%, transparent)`, background: `color-mix(in oklch, ${color} 12%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {roleLabel(role)}
    </span>
  );
}
