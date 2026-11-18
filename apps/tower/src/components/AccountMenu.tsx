import { useRef, useState } from 'react';
import { ArrowLeftRight, CircleUserRound, LogOut, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { NavItem } from '@/components/nav-items';
import { useBrowserContext } from '@/lib/browser-context';
import { cn } from '@/lib/utils';

export const ACCOUNT_PROFILE_PAGE: NavItem = {
  to: '/profile', label: 'Profile', icon: UserRound, keywords: ['account', 'personal details'],
};

export function AccountMenu({ className, align }: { className?: string; align?: 'start' | 'end' }) {
  const { workspaceLabel, switchWorkspace, logout } = useBrowserContext();
  const [open, setOpen] = useState(false);
  const firstAction = useRef<HTMLAnchorElement>(null);
  if (!workspaceLabel || !switchWorkspace || !logout) return null;

  const item = 'min-h-11 w-full justify-start gap-2';
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" aria-label="Account menu" title={workspaceLabel}
        className={cn('min-h-11 min-w-0 gap-2', className)}>
        <CircleUserRound aria-hidden className="size-5 shrink-0" />
        <span>Account</span>
        <span className="ml-auto hidden min-w-0 truncate text-xs text-muted-foreground md:block">{workspaceLabel}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align={align} aria-label="Account" className="w-56 p-1"
      onOpenAutoFocus={event => { event.preventDefault(); firstAction.current?.focus(); }}>
      <div className="px-3 py-2 text-xs break-words text-muted-foreground">{workspaceLabel}</div>
      <Button asChild variant="ghost" className={item}>
        <Link ref={firstAction} to={ACCOUNT_PROFILE_PAGE.to} onClick={() => setOpen(false)}>
          <UserRound aria-hidden />{ACCOUNT_PROFILE_PAGE.label}
        </Link>
      </Button>
      <Button type="button" variant="ghost" className={item} onClick={() => { setOpen(false); switchWorkspace(); }}>
        <ArrowLeftRight aria-hidden />Switch workspace
      </Button>
      <Button type="button" variant="ghost" className={item} onClick={() => { setOpen(false); void logout(); }}>
        <LogOut aria-hidden />Sign out
      </Button>
    </PopoverContent>
  </Popover>;
}
