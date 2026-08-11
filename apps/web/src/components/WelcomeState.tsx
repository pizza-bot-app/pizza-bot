import type { AgentInfo } from "@/api-client";
import { ArrowRight } from "lucide-react";
import { Avatar } from "./Avatar.js";

export function WelcomeState({
  agent,
  onPrefill,
}: {
  agent?: AgentInfo;
  onPrefill: (prompt: string) => void;
}) {
  const name = agent?.name ?? "Pizza Bot";
  const description =
    agent?.description ??
    "Your guide to Pizza Bot. Ask anything to get started.";
  const prompts = agent?.suggestedPrompts ?? [];

  return (
    <div className="welcome">
      <div className="welcome-head">
        <Avatar label={name} avatar={agent?.avatar} size={56} />
        <h2 className="welcome-title">Chat with {name}</h2>
        <p className="welcome-desc">{description}</p>
      </div>

      {prompts.length > 0 && (
        <div className="welcome-suggestions">
          <p className="welcome-suggestions-label">Try these suggestions to get started:</p>
          <div className="welcome-grid">
            {prompts.map((p, i) => (
              <button
                key={`${p.suggestion}-${i}`}
                className="welcome-card"
                onClick={() => onPrefill(p.prompt)}
              >
                <span className="welcome-card-title">{p.suggestion}</span>
                <span className="welcome-card-cta" aria-hidden="true">
                  <ArrowRight size={17} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
