import { useEffect, useId, useRef, useState } from "react";

type JsonPath = Array<string | number>;

interface ApprovalArgumentsProps {
  value: unknown;
}

interface ApprovalArgumentEditorProps {
  value: unknown;
  rawDraft: string;
  rawError: string | null;
  onChange: (value: unknown) => void;
  onRawChange: (value: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStructured(value: unknown): value is Record<string, unknown> | unknown[] {
  return isRecord(value) || Array.isArray(value);
}

const LABEL_ACRONYMS = new Set([
  "api",
  "arn",
  "aws",
  "html",
  "http",
  "https",
  "id",
  "json",
  "mcp",
  "sql",
  "uri",
  "url",
]);

export function formatArgumentLabel(key: string): string {
  const tokens = key
    .replace(/[_-]+/g, " ")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      return LABEL_ACRONYMS.has(lower) ? lower.toUpperCase() : lower;
    });
  if (tokens.length === 0) return key;
  if (!LABEL_ACRONYMS.has(tokens[0]!.toLowerCase())) {
    tokens[0] = tokens[0]!.charAt(0).toUpperCase() + tokens[0]!.slice(1);
  }
  return tokens.join(" ");
}

export function updateArgumentAtPath(value: unknown, path: JsonPath, next: unknown): unknown {
  if (path.length === 0) return next;

  const [head, ...tail] = path;
  if (Array.isArray(value) && typeof head === "number") {
    const copy = [...value];
    copy[head] = updateArgumentAtPath(copy[head], tail, next);
    return copy;
  }
  if (isRecord(value) && typeof head === "string") {
    return {
      ...value,
      [head]: updateArgumentAtPath(value[head], tail, next),
    };
  }
  return value;
}

export type ParsedArgumentDraft =
  | { ok: true; value: unknown; error: null }
  | { ok: false; error: string };

export function parseArgumentDraft(draft: string): ParsedArgumentDraft {
  try {
    return { ok: true, value: JSON.parse(draft), error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

function ScalarValue({
  children,
  type,
  empty = false,
  showType = false,
}: {
  children: string;
  type: "Boolean" | "Null" | "Number" | "Text";
  empty?: boolean;
  showType?: boolean;
}) {
  return (
    <span className="approval-argument-scalar">
      <span className={empty ? "approval-argument-empty" : "approval-argument-value"}>
        {children}
      </span>
      {showType && <span className="approval-argument-type">{type}</span>}
    </span>
  );
}

function isAmbiguousText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized !== "" &&
    (Number.isFinite(Number(normalized)) ||
      normalized === "true" ||
      normalized === "false" ||
      normalized === "null")
  );
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) {
    return <ScalarValue type="Null" empty showType>Not set</ScalarValue>;
  }
  if (typeof value === "boolean") {
    return <ScalarValue type="Boolean">{value ? "Yes" : "No"}</ScalarValue>;
  }
  if (typeof value === "number") {
    return <ScalarValue type="Number">{String(value)}</ScalarValue>;
  }
  if (typeof value === "string") {
    return value === "" ? (
      <ScalarValue type="Text" empty showType>
        Empty text
      </ScalarValue>
    ) : (
      <ScalarValue type="Text" showType={isAmbiguousText(value)}>{value}</ScalarValue>
    );
  }
  return <span className="approval-argument-value">{String(value)}</span>;
}

function ArgumentValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="approval-argument-empty">None</span>;
    return (
      <ol className="approval-argument-list">
        {value.map((item, index) => (
          <li key={index}>
            <span className="approval-argument-index">{index + 1}</span>
            <ArgumentValue value={item} />
          </li>
        ))}
      </ol>
    );
  }

  if (isRecord(value)) {
    if (Object.keys(value).length === 0) {
      return <span className="approval-argument-empty">None</span>;
    }
    return (
      <dl className="approval-argument-nested">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt title={key}>{formatArgumentLabel(key)}</dt>
            <dd>
              <ArgumentValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <PrimitiveValue value={value} />;
}

export function ApprovalArguments({ value }: ApprovalArgumentsProps) {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return <div className="approval-arguments-empty">No arguments</div>;
    }
    return (
      <dl className="approval-arguments">
        {entries.map(([key, item]) => (
          <div className="approval-argument" key={key}>
            <dt title={key}>{formatArgumentLabel(key)}</dt>
            <dd>
              <ArgumentValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <div className="approval-arguments approval-arguments-single">
      <ArgumentValue value={value} />
    </div>
  );
}

function resizeArgumentTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  const borderHeight = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = `${Math.min(textarea.scrollHeight + borderHeight, 180)}px`;
}

function TextArgumentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) resizeArgumentTextarea(textareaRef.current);
  }, [value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;

    let width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      resizeArgumentTextarea(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);

  return (
    <label className="approval-field" htmlFor={inputId}>
      <span className="approval-field-label">{label}</span>
      <textarea
        ref={textareaRef}
        id={inputId}
        className="approval-field-text"
        value={value}
        rows={1}
        onChange={(event) => {
          resizeArgumentTextarea(event.currentTarget);
          onChange(event.target.value);
        }}
        spellCheck
        wrap="soft"
      />
    </label>
  );
}

function NumberArgumentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (next: string) => {
    setDraft(next);
    if (next.trim() === "") return;
    const parsed = Number(next);
    if (Number.isFinite(parsed)) onChange(parsed);
  };

  return (
    <label className="approval-field" htmlFor={inputId}>
      <span className="approval-field-label">{label}</span>
      <input
        id={inputId}
        className="approval-field-input"
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => {
          const parsed = Number(draft);
          setDraft(
            draft.trim() !== "" && Number.isFinite(parsed) ? String(parsed) : String(value),
          );
        }}
      />
    </label>
  );
}

function NullArgumentField({
  label,
  onChange,
}: {
  label: string;
  onChange: (value: unknown) => void;
}) {
  const inputId = useId();
  return (
    <label className="approval-field" htmlFor={inputId}>
      <span className="approval-field-label">{label}</span>
      <select
        id={inputId}
        className="approval-field-input approval-null-type"
        value="null"
        onChange={(event) => {
          if (event.target.value === "string") onChange("");
          if (event.target.value === "number") onChange(0);
          if (event.target.value === "boolean") onChange(false);
        }}
      >
        <option value="null">Not set</option>
        <option value="string">Text</option>
        <option value="number">Number</option>
        <option value="boolean">Yes / no</option>
      </select>
    </label>
  );
}

function ArgumentField({
  label,
  value,
  path,
  onChange,
}: {
  label: string;
  value: unknown;
  path: JsonPath;
  onChange: (path: JsonPath, value: unknown) => void;
}) {
  if (Array.isArray(value)) {
    return (
      <div className="approval-field approval-field-group">
        <div className="approval-field-label">{label}</div>
        <div className="approval-field-children">
          {value.length === 0 ? (
            <span className="approval-argument-empty">None</span>
          ) : (
            value.map((item, index) => (
              <ArgumentField
                key={index}
                label={`Item ${index + 1}`}
                value={item}
                path={[...path, index]}
                onChange={onChange}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  if (isRecord(value)) {
    return (
      <div className="approval-field approval-field-group">
        <div className="approval-field-label">{label}</div>
        <div className="approval-field-children">
          {Object.keys(value).length === 0 ? (
            <span className="approval-argument-empty">None</span>
          ) : (
            Object.entries(value).map(([key, item]) => (
              <ArgumentField
                key={key}
                label={formatArgumentLabel(key)}
                value={item}
                path={[...path, key]}
                onChange={onChange}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  if (typeof value === "boolean") {
    return (
      <div className="approval-field approval-field-boolean">
        <span className="approval-field-label">{label}</span>
        <label className="approval-boolean-control">
          <input
            type="checkbox"
            checked={value}
            onChange={(event) => onChange(path, event.target.checked)}
          />
          <span>{value ? "Yes" : "No"}</span>
        </label>
      </div>
    );
  }

  if (typeof value === "number") {
    return (
      <NumberArgumentField
        label={label}
        value={value}
        onChange={(next) => onChange(path, next)}
      />
    );
  }

  if (typeof value === "string") {
    return (
      <TextArgumentField
        label={label}
        value={value}
        onChange={(next) => onChange(path, next)}
      />
    );
  }

  if (value === null) {
    return <NullArgumentField label={label} onChange={(next) => onChange(path, next)} />;
  }

  return <PrimitiveValue value={value} />;
}

export function ApprovalArgumentEditor({
  value,
  rawDraft,
  rawError,
  onChange,
  onRawChange,
}: ApprovalArgumentEditorProps) {
  const supportsFields =
    isStructured(value) && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0);
  const [mode, setMode] = useState<"fields" | "json">(supportsFields ? "fields" : "json");
  const errorId = useId();

  const updateField = (path: JsonPath, next: unknown) => {
    onChange(updateArgumentAtPath(value, path, next));
  };

  return (
    <div className="approval-editor">
      {supportsFields && (
        <div className="approval-editor-modes" role="group" aria-label="Argument editor view">
          <button
            type="button"
            aria-pressed={mode === "fields"}
            aria-disabled={Boolean(rawError)}
            aria-describedby={rawError ? errorId : undefined}
            className={mode === "fields" ? "active" : undefined}
            onClick={() => {
              if (!rawError) setMode("fields");
            }}
          >
            Fields
          </button>
          <button
            type="button"
            aria-pressed={mode === "json"}
            className={mode === "json" ? "active" : undefined}
            onClick={() => setMode("json")}
          >
            JSON
          </button>
        </div>
      )}

      {mode === "fields" && supportsFields ? (
        <div className="approval-fields">
          {Array.isArray(value) ? (
            value.map((item, index) => (
              <ArgumentField
                key={index}
                label={`Item ${index + 1}`}
                value={item}
                path={[index]}
                onChange={updateField}
              />
            ))
          ) : (
            Object.entries(value).map(([key, item]) => (
              <ArgumentField
                key={key}
                label={formatArgumentLabel(key)}
                value={item}
                path={[key]}
                onChange={updateField}
              />
            ))
          )}
        </div>
      ) : (
        <textarea
          className="approval-json-editor"
          rows={Math.min(14, Math.max(5, rawDraft.split("\n").length + 1))}
          value={rawDraft}
          onChange={(event) => onRawChange(event.target.value)}
          aria-invalid={Boolean(rawError)}
          aria-label="Tool arguments as JSON"
          spellCheck={false}
          wrap="soft"
        />
      )}

      {rawError && (
        <span className="approval-editor-error" id={errorId} role="alert">
          {rawError}
        </span>
      )}
    </div>
  );
}
