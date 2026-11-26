// --- Settings › Agent: the model picker (#2101 ST2a) ---
//
// The approved mock (agent-model-picker-*.png): a Command in a Popover,
// the models grouped by engine under the engine's logo (its brand colours,
// the one colour exception), searchable. A name typed that is not listed
// is offered as it is, so a new model needs no release; empty is the
// engine's default. Picking a model of another engine moves the engine too,
// so the pair stays one that runs.
import { Fragment, useState } from "react"
import { Button, Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, Icon, Popover, PopoverContent, PopoverTrigger, cn } from "../ui"
import { MODEL_GROUPS, modelTier } from "./agent-data"
import { engineName } from "./data"
import { EngineLogo } from "./GeneralPane"

export function ModelPicker({ value, tier, onChange, className }: {
  value: string; tier: string; onChange: (model: string, tier?: string) => void; className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const typed = query.trim()
  const listed = MODEL_GROUPS.some((g) => g.models.includes(typed))
  // The agent's own engine first.
  const groups = [...MODEL_GROUPS].sort((a, b) => Number(b.tier === tier) - Number(a.tier === tier))
  const pick = (model: string) => {
    const t = modelTier(model)
    onChange(model, t && t !== tier ? t : undefined)
    setOpen(false)
    setQuery("")
  }
  const check = (on: boolean) => <Icon name="check" className={cn("ml-auto size-3.5", !on && "invisible")} />
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery("") }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline" size="sm" role="combobox" aria-expanded={open} aria-label="Model"
          className={cn("w-[200px] justify-between px-2.5 font-mono text-xs font-normal shadow-xs", className)}
        >
          <span className={cn("truncate", !value && "font-sans text-muted-foreground")}>{value || "Engine's default"}</span>
          <Icon name="chevrons-up-down" className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[240px] p-0">
        <Command>
          <CommandInput placeholder="Search or type a model" value={query} onValueChange={setQuery} />
          <CommandList>
            {typed && !listed && (
              <CommandGroup forceMount>
                <CommandItem forceMount value={"use " + typed} onSelect={() => pick(typed)} className="font-mono text-xs">
                  <Icon name="plus" className="size-3.5" />Use {typed}
                </CommandItem>
              </CommandGroup>
            )}
            {groups.map((g, i) => (
              <Fragment key={g.tier}>
                {i > 0 && <CommandSeparator />}
                <CommandGroup className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:normal-case [&_[cmdk-group-heading]]:tracking-normal" heading={<span className="flex items-center gap-1.5"><EngineLogo tier={g.tier} />{engineName(g.tier)}</span>}>
                  {g.models.map((m) => (
                    <CommandItem key={m} value={m} keywords={[engineName(g.tier)]} onSelect={() => pick(m)} className="font-mono text-xs">
                      {m}{check(m === value)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </Fragment>
            ))}
            {!typed && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="engine default" onSelect={() => pick("")}>The engine's default{check(!value)}</CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
