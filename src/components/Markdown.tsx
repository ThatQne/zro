import React, { useMemo } from "react";
import { useBrowserStore } from "../store/tabs";

/** Minimal markdown for chat bubbles: **bold**, *italic*, `code`, ``` blocks,
 *  # headers, -/1. lists, [links](url) + bare URLs. Links open in a new tab. */

const INLINE_RE =
  /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(`([^`\n]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s)\]}"'<>]+)/g;

function renderInline(
  text: string,
  openLink: (url: string) => void,
  keyBase: string
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[2] !== undefined) {
      out.push(<strong key={k} style={{ color: "#c8c8c8", fontWeight: 600 }}>{renderInline(m[2], openLink, k)}</strong>);
    } else if (m[4] !== undefined) {
      out.push(<em key={k}>{renderInline(m[4], openLink, k)}</em>);
    } else if (m[6] !== undefined) {
      out.push(
        <code key={k} style={{
          background: "rgba(255,255,255,0.07)", borderRadius: 3,
          padding: "0.5px 4px", fontSize: "0.92em", fontFamily: "Consolas, monospace",
          color: "#b8c4e8",
        }}>{m[6]}</code>
      );
    } else if (m[8] !== undefined && m[9] !== undefined) {
      out.push(<MdLink key={k} label={m[8]} url={m[9]} openLink={openLink} />);
    } else if (m[10] !== undefined) {
      const short = m[10].replace(/^https?:\/\/(www\.)?/, "").slice(0, 48);
      out.push(<MdLink key={k} label={short} url={m[10]} openLink={openLink} />);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function MdLink({ label, url, openLink }: { label: string; url: string; openLink: (u: string) => void }) {
  return (
    <a
      onClick={(e) => { e.preventDefault(); openLink(url); }}
      title={url}
      style={{
        color: "#6a93f8", textDecoration: "underline",
        textDecorationColor: "rgba(106,147,248,0.35)", cursor: "pointer",
      }}
    >
      {label}
    </a>
  );
}

interface Block {
  kind: "code" | "text";
  content: string;
  lang?: string;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const parts = text.split(/```/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // Inside a fence — first line may be a language tag
      const nl = parts[i].indexOf("\n");
      const lang = nl > -1 ? parts[i].slice(0, nl).trim() : "";
      const body = nl > -1 ? parts[i].slice(nl + 1) : parts[i];
      blocks.push({ kind: "code", content: body.replace(/\n$/, ""), lang });
    } else if (parts[i]) {
      blocks.push({ kind: "text", content: parts[i] });
    }
  }
  return blocks;
}

export default function Markdown({ text }: { text: string }) {
  const { createTab } = useBrowserStore();
  const openLink = (url: string) => { createTab(url); };

  const rendered = useMemo(() => {
    const blocks = splitBlocks(text);
    const out: React.ReactNode[] = [];

    blocks.forEach((block, bi) => {
      if (block.kind === "code") {
        out.push(
          <pre key={`b${bi}`} style={{
            background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6, padding: "7px 9px", margin: "6px 0",
            fontSize: 10.5, lineHeight: 1.5, overflowX: "auto",
            fontFamily: "Consolas, monospace", color: "#a8b4d8",
            whiteSpace: "pre",
          }}>{block.content}</pre>
        );
        return;
      }

      // Text block → line-level structures
      const lines = block.content.split("\n");
      let listItems: { text: string; ordered: boolean }[] = [];
      let li = 0;

      const flushList = () => {
        if (listItems.length === 0) return;
        const ordered = listItems[0].ordered;
        const items = listItems.map((it, ii) => (
          <li key={ii} style={{ marginBottom: 2 }}>
            {renderInline(it.text, openLink, `b${bi}l${li}i${ii}`)}
          </li>
        ));
        out.push(
          ordered
            ? <ol key={`b${bi}ol${li++}`} style={{ margin: "4px 0", paddingLeft: 18 }}>{items}</ol>
            : <ul key={`b${bi}ul${li++}`} style={{ margin: "4px 0", paddingLeft: 16 }}>{items}</ul>
        );
        listItems = [];
      };

      lines.forEach((line, lineIdx) => {
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        const header = /^(#{1,4})\s+(.*)$/.exec(line);

        if (bullet) {
          listItems.push({ text: bullet[1], ordered: false });
          return;
        }
        if (numbered) {
          listItems.push({ text: numbered[1], ordered: true });
          return;
        }
        flushList();
        const key = `b${bi}ln${lineIdx}`;
        if (header) {
          out.push(
            <div key={key} style={{
              fontWeight: 600, color: "#c0c0c0", margin: "7px 0 3px",
              fontSize: header[1].length <= 2 ? 12.5 : 12,
            }}>
              {renderInline(header[2], openLink, key)}
            </div>
          );
        } else if (line.trim() === "") {
          out.push(<div key={key} style={{ height: 5 }} />);
        } else {
          out.push(<div key={key}>{renderInline(line, openLink, key)}</div>);
        }
      });
      flushList();
    });

    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return <>{rendered}</>;
}
