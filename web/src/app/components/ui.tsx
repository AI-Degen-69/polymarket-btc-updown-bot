import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, Info, Loader2, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'

import { cx } from '../lib/cx'
import { initials } from '../lib/format'

// Buttons, inputs and selects share one height per size so controls that sit
// beside each other line up: md = 36px, sm = 32px.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'md' | 'sm' | 'icon' | 'icon-sm'

// No disabled:pointer-events-none — it would defeat the not-allowed cursor and the title tooltip on disabled buttons.
const buttonBase =
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:opacity-50 disabled:hover:bg-transparent [&_svg]:size-4 [&_svg]:shrink-0'
const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-fg text-surface shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] hover:bg-fg/85',
  secondary: 'border border-line-strong bg-surface text-fg shadow-[0_1px_1px_rgb(20_20_24/0.04)] hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-surface hover:bg-danger/85',
}
const buttonSizes: Record<ButtonSize, string> = {
  md: 'h-9 px-3.5 text-[13.5px]',
  sm: 'h-8 px-3 text-[13px] rounded-tile',
  icon: 'size-9',
  'icon-sm': 'size-8 rounded-tile',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  loading,
  children,
  ...rest
}: ComponentPropsWithoutRef<'button'> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }) {
  return (
    <button type="button" className={cx(buttonBase, buttonVariants[variant], buttonSizes[size], className)} {...rest} disabled={loading || rest.disabled}>
      {loading ? <Loader2 className="animate-spin" /> : children}
    </button>
  )
}

export const inputClass =
  'h-9 w-full min-w-0 rounded-control border border-line-strong bg-surface px-3 text-[13.5px] text-fg placeholder:text-faint transition-[border-color,box-shadow] focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/15 disabled:opacity-60'
// Same control with a danger outline, for out-of-range values.
export const invalidInputClass =
  'h-9 w-full min-w-0 rounded-control border border-danger bg-surface px-3 text-[13.5px] text-fg placeholder:text-faint transition-[border-color,box-shadow] focus:border-danger focus:outline-none focus:ring-[3px] focus:ring-danger/15 disabled:opacity-60'

export function Input({ className, id, invalid, ...rest }: ComponentPropsWithoutRef<'input'> & { invalid?: boolean }) {
  const fieldId = useFieldId()
  return <input id={id ?? fieldId} aria-invalid={invalid || undefined} className={cx(invalid ? invalidInputClass : inputClass, className)} {...rest} />
}

export function Textarea({ className, ...rest }: ComponentPropsWithoutRef<'textarea'>) {
  return <textarea className={cx(inputClass, 'h-auto min-h-[88px] resize-y py-2 leading-relaxed', className)} {...rest} />
}

export function Select({ className, children, id, ...rest }: ComponentPropsWithoutRef<'select'>) {
  const fieldId = useFieldId()
  return (
    <span className={cx('relative block', className)}>
      <select id={id ?? fieldId} className={cx(inputClass, 'appearance-none pr-9')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
    </span>
  )
}

export function Checkbox({ className, ...rest }: ComponentPropsWithoutRef<'input'>) {
  return (
    <span className={cx('relative inline-grid size-4.5 shrink-0 place-items-center', className)}>
      <input
        type="checkbox"
        className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-[6px] border border-line-strong bg-surface transition-colors checked:border-fg checked:bg-fg disabled:cursor-default"
        {...rest}
      />
      <svg viewBox="0 0 16 16" className="pointer-events-none relative size-3 opacity-0 transition-opacity peer-checked:opacity-100" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3.5 8.5l2.8 2.8L12.5 5" />
      </svg>
    </span>
  )
}

export function Field({ label, children, hint, tip, error, className }: { label: string; children: ReactNode; hint?: string; tip?: ReactNode; error?: string; className?: string }) {
  const id = useId()
  const tipId = useId()
  const errorId = `${id}-error`
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="flex w-fit min-w-0 items-center gap-1.5 text-[13px] font-medium text-fg">
        <span className="truncate" title={label}>{label}</span>
        {tip && (
          <span className="group/tip relative inline-flex">
            <span
              tabIndex={0}
              aria-label={`About: ${label}`}
              className="cursor-help rounded-full text-faint transition-colors hover:text-fg focus-visible:text-fg"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </span>
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 hidden w-72 rounded-tile bg-fg px-3 py-2.5 text-surface shadow-pop group-hover/tip:block group-focus-within/tip:block"
            >
              {tip}
            </span>
          </span>
        )}
      </label>
      <FieldIdContext.Provider value={id}>{children}</FieldIdContext.Provider>
      {error && <span role="alert" className="text-[11.5px] font-medium text-danger">{error}</span>}
      {!error && hint && <span className="text-[12px] text-faint">{hint}</span>}
    </div>
  )
}
const FieldIdContext = createContext<string | undefined>(undefined)
export const useFieldId = () => useContext(FieldIdContext)

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
}
export function Badge({ tone = 'neutral', className, children, dot }: { tone?: Tone; className?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-2 text-[12px] font-medium', toneClasses[tone], className)}>
      {dot && <span className="round size-1.5 bg-current" />}
      {children}
    </span>
  )
}

export function Avatar({
  name,
  hue,
  src,
  size = 32,
  className,
}: {
  name: string
  hue: number
  src?: string | null
  size?: number
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) }
  if (src && !broken) {
    return <img src={src} alt="" onError={() => setBroken(true)} className={cx('round shrink-0 rounded-full object-cover', className)} style={style} />
  }
  return (
    <span
      className={cx('round grid shrink-0 place-items-center rounded-full font-semibold text-white', className)}
      style={{ ...style, background: `linear-gradient(135deg, hsl(${hue} 60% 62%), hsl(${hue + 35} 60% 48%))` }}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}

export function CompanyMark({ name, hue, size = 32, className }: { name: string; hue: number; size?: number; className?: string }) {
  return (
    <span
      className={cx('grid shrink-0 place-items-center rounded-tile font-semibold', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.4)),
        background: `hsl(${hue} 55% 94%)`,
        color: `hsl(${hue} 50% 38%)`,
        borderRadius: Math.round(size * 0.32),
      }}
      aria-hidden
    >
      {name.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-faint', className)} />
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-tile bg-raised/70', className)} />
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-4 grid size-12 place-items-center rounded-card bg-surface-2 text-muted [&_svg]:size-5">{icon}</div>}
      <p className="text-[15px] font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13.5px] text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Card({ className, children, ...rest }: ComponentPropsWithoutRef<'section'>) {
  return (
    <section className={cx('rounded-card bg-surface shadow-card', className)} {...rest}>
      {children}
    </section>
  )
}

// Dialog and Drawer share the overlay: Escape or backdrop closes, scroll is
// locked while open, focus moves to the first field.

function useOverlay(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const previous = document.activeElement as HTMLElement | null
    const timer = window.setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])')
      first?.focus()
    }, 30)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
      previous?.focus?.()
    }
  }, [open, onClose])
  return ref
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const ref = useOverlay(open, onClose)
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="overlay"
          className="fixed inset-0 z-50 flex items-end justify-center bg-fg/30 p-4 backdrop-blur-[2px] sm:items-center cursor-pointer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal
            aria-label={title}
            className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-dialog bg-surface shadow-dialog"
            style={{ maxWidth: width }}
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="flex items-start justify-between gap-4 px-6 pt-5">
              <div>
                <h2 className="text-[16px] font-semibold">{title}</h2>
                {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
              </div>
              <Button data-close variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className="-mr-2 -mt-1">
                <X />
              </Button>
            </header>
            <div className="scrollbar-thin overflow-y-auto px-6 py-5">{children}</div>
            {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  header,
  width = 520,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  header?: ReactNode
  width?: number
}) {
  const ref = useOverlay(open, onClose)
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="overlay"
          className="fixed inset-0 z-50 cursor-pointer bg-fg/20"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.aside
            ref={ref}
            role="dialog"
            aria-modal
            aria-label={title}
            className="absolute inset-y-2 right-2 flex w-[calc(100%-16px)] flex-col overflow-hidden rounded-dialog bg-surface shadow-dialog"
            style={{ maxWidth: width }}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
              <div className="min-w-0 flex-1">{header ?? <h2 className="truncate text-[15px] font-semibold">{title}</h2>}</div>
              <Button data-close variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
                <X />
              </Button>
            </header>
            <div className="scrollbar-thin flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  loading,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: string
  confirmLabel?: string
  loading?: boolean
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] text-muted">{description}</p>
    </Dialog>
  )
}

// Toasts
type Toast = { id: number; message: string; tone: 'neutral' | 'danger' }
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {})
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((message: string, tone: Toast['tone'] = 'neutral') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, message, tone }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex flex-col items-center gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              className={cx(
                'pointer-events-auto rounded-control px-4 py-2.5 text-[13.5px] font-medium shadow-pop',
                t.tone === 'danger' ? 'bg-danger text-surface' : 'bg-fg text-surface',
              )}
            >
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13.5px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
