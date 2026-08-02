import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  h1: ({ children }) => <h1 className="mt-3 mb-2 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-2 text-sm font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1.5 text-sm font-semibold">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = typeof className === "string" && className.includes("language-");
    if (isBlock) {
      return <code className={cn("font-mono text-xs", className)}>{children}</code>;
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 max-h-72 overflow-auto rounded-md border bg-muted/60 p-2.5 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => <th className="border-b border-border px-2 py-1.5 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-border px-2 py-1.5 align-top">{children}</td>,
  hr: () => <hr className="my-3 border-border" />,
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ""} loading="lazy" className="my-2 max-h-64 rounded-md border object-contain" />
  ),
};

/** Renderiza markdown de respostas do agente (GFM: tabelas, links, listas…). */
export function MarkdownMessage({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-sm text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
