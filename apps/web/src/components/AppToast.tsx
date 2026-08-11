import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

type ToastTone = "info" | "success" | "error";

interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface ToastEntry extends ToastInput {
  id: number;
  tone: ToastTone;
}

type ToastContextValue = (toast: ToastInput) => void;

const ToastContext = createContext<ToastContextValue | null>(null);

const icons: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

export function AppToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [
        ...current.slice(-2),
        { ...input, id, tone: input.tone ?? "info" },
      ]);
      window.setTimeout(() => dismiss(id), input.tone === "error" ? 6500 : 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="app-toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => {
          const Icon = icons[toast.tone];
          return (
            <div
              className={`app-toast ${toast.tone}`}
              key={toast.id}
              role={toast.tone === "error" ? "alert" : "status"}
            >
              <Icon className="app-toast-icon" size={17} />
              <div className="app-toast-content">
                <div className="app-toast-title">{toast.title}</div>
                {toast.description && (
                  <div className="app-toast-description">{toast.description}</div>
                )}
              </div>
              <button
                className="app-toast-close"
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(toast.id)}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useAppToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useAppToast must be used inside AppToastProvider");
  return context;
}
