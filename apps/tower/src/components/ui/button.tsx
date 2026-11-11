import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Precise's button (Ntasks docs/design.md, Button): 30px, 26px small, 6px
 * corners, the label at 13px. `default` is the view's one primary action in
 * the accent, `outline` the raised secondary on Background, `ghost` a bare
 * label in Text 2. Below `sm` every size grows to the 44px thumb target.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-[background-color,color,filter] duration-[var(--brand-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        outline: "bg-background text-foreground shadow-raise ring-1 ring-inset ring-border hover:bg-muted [&_svg]:text-muted-foreground",
        ghost: "text-secondary-foreground hover:bg-muted hover:text-foreground [&_svg]:text-muted-foreground",
      },
      size: {
        default: "h-7.5 gap-1.5 px-2.5 text-label max-sm:min-h-11 max-sm:min-w-11 [&_svg]:size-3.75",
        sm: "h-6.5 gap-1.25 px-2 text-meta max-sm:min-h-11 max-sm:min-w-11 [&_svg]:size-3.5",
        icon: "size-7.5 max-sm:size-11 [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
