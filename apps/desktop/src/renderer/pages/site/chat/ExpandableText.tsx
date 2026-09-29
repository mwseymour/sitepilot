import { useState, type ReactElement } from "react";

type ExpandableTextProps = {
  text: string;
  className: string;
  collapsedClassName: string;
  expandedClassName?: string;
  previewThreshold: number;
};

export function ExpandableText({
  text,
  className,
  collapsedClassName,
  expandedClassName,
  previewThreshold
}: ExpandableTextProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const trimmedText = text.trim();
  const isLong = trimmedText.length > previewThreshold;

  return (
    <div className="chat-expandable-text">
      <span
        className={[
          className,
          isLong && !expanded ? collapsedClassName : "",
          expanded && expandedClassName ? expandedClassName : ""
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {text}
      </span>
      {isLong ? (
        <button
          type="button"
          className="chat-inline-toggle"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          View {expanded ? "less" : "more"}
        </button>
      ) : null}
    </div>
  );
}
