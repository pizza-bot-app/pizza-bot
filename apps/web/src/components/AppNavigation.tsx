import { Fragment } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Brain,
  Cable,
  Inbox,
  MoreHorizontal,
  Pizza,
  Puzzle,
  ScrollText,
  Settings,
  Workflow,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppView } from "../admin-visibility.js";
import { L } from "../lexicon.js";

interface AppNavigationProps {
  view: AppView;
  enableAutomations: boolean;
  enableMemories: boolean;
  onViewChange: (view: AppView) => void;
}

interface NavDestination {
  view: AppView;
  label: string;
  mobileLabel?: string;
  icon: LucideIcon;
}

const inboxDestination: NavDestination = {
  view: "inbox",
  label: L.inboxSection,
  icon: Inbox,
};

const automationsDestination: NavDestination = {
  view: "automations",
  label: L.automationsSection,
  icon: Workflow,
};

const memoriesDestination: NavDestination = {
  view: "memories",
  label: L.memoriesSection,
  icon: Brain,
};

const skillsDestination: NavDestination = {
  view: "skills",
  label: L.skillsSection,
  icon: BookOpen,
};

const mcpDestination: NavDestination = {
  view: "mcp",
  label: L.mcpSection,
  icon: Cable,
};

const pluginsDestination: NavDestination = {
  view: "plugins",
  label: L.pluginsSection,
  icon: Puzzle,
};

const settingsDestination: NavDestination = {
  view: "settings",
  label: L.settingsSection,
  icon: Settings,
};

const logsDestination: NavDestination = {
  view: "logs",
  label: "Logs",
  icon: ScrollText,
};

function RailButton({
  destination,
  view,
  onViewChange,
}: {
  destination: NavDestination;
  view: AppView;
  onViewChange: (view: AppView) => void;
}) {
  const Icon = destination.icon;
  const active = view === destination.view;

  return (
    <button
      className={`iconrail-btn${active ? " active" : ""}`}
      title={destination.label}
      aria-label={destination.label}
      aria-current={active ? "page" : undefined}
      onClick={() => onViewChange(destination.view)}
    >
      <Icon size={20} />
    </button>
  );
}

function MobileNavButton({
  destination,
  view,
  onViewChange,
}: {
  destination: NavDestination;
  view: AppView;
  onViewChange: (view: AppView) => void;
}) {
  const Icon = destination.icon;
  const active = view === destination.view;

  return (
    <button
      className={`mobile-nav-btn${active ? " active" : ""}`}
      aria-label={destination.label}
      aria-current={active ? "page" : undefined}
      onClick={() => onViewChange(destination.view)}
    >
      <Icon size={20} />
      <span>{destination.mobileLabel ?? destination.label}</span>
    </button>
  );
}

export function AppNavigation({
  view,
  enableAutomations,
  enableMemories,
  onViewChange,
}: AppNavigationProps) {
  const desktopDestinations = [
    inboxDestination,
    skillsDestination,
    mcpDestination,
    ...(enableMemories ? [memoriesDestination] : []),
    ...(enableAutomations ? [automationsDestination] : []),
  ];
  const mobileDestinations = [
    inboxDestination,
    skillsDestination,
    mcpDestination,
  ];
  const mobileFeatureDestinations = [
    ...(enableMemories ? [memoriesDestination] : []),
    ...(enableAutomations ? [automationsDestination] : []),
  ];
  const utilityDestinations = [
    pluginsDestination,
    logsDestination,
    settingsDestination,
  ];
  const moreDestinations = [...mobileFeatureDestinations, ...utilityDestinations];
  const moreActive = moreDestinations.some((destination) => destination.view === view);

  return (
    <>
      <nav className="iconrail" aria-label="Primary navigation">
        <div className="iconrail-logo" role="img" aria-label="Pizza Bot" title="Pizza Bot">
          <Pizza size={24} strokeWidth={1.8} />
        </div>
        {desktopDestinations.map((destination) => (
          <RailButton
            key={destination.view}
            destination={destination}
            view={view}
            onViewChange={onViewChange}
          />
        ))}
        <div className="iconrail-spacer" />
        {utilityDestinations.map((destination) => (
          <RailButton
            key={destination.view}
            destination={destination}
            view={view}
            onViewChange={onViewChange}
          />
        ))}
      </nav>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {mobileDestinations.map((destination) => (
          <MobileNavButton
            key={destination.view}
            destination={destination}
            view={view}
            onViewChange={onViewChange}
          />
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={`mobile-nav-btn${moreActive ? " active" : ""}`}
              aria-label="More destinations"
              aria-current={moreActive ? "page" : undefined}
            >
              <MoreHorizontal size={20} />
              <span>More</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="mobile-nav-menu"
            side="top"
            align="end"
            sideOffset={8}
          >
            {moreDestinations.map((destination, index) => {
              const Icon = destination.icon;
              return (
                <Fragment key={destination.view}>
                  {index === mobileFeatureDestinations.length &&
                    mobileFeatureDestinations.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    className={`mobile-nav-menu-item${
                      view === destination.view ? " active" : ""
                    }`}
                    onSelect={() => onViewChange(destination.view)}
                  >
                    <Icon />
                    {destination.label}
                  </DropdownMenuItem>
                </Fragment>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </>
  );
}
