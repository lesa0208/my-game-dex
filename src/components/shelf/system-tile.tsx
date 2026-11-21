import { Gamepad2, Plus } from "lucide-react";
import Link from "next/link";

import type { SystemWithStats } from "@/features/shelf/queries";
import { cn } from "@/lib/utils";

import { ConsoleArt, consoleTileBox } from "./console-art";

function count(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}

/** A system's display case on the Systems shelf: its name, console and game count. */
export function SystemTile({ system }: { system: SystemWithStats }) {
  const [accent, accentLight] = system.accent;
  const { games, copies } = system.stats;
  const empty = games === 0;
  return (
    <Link
      href={`/collection/systems/${system.slug}`}
      className="group relative block aspect-16/10 overflow-hidden rounded-xl border border-white/10 bg-[#16151c] shadow-[0_14px_30px_-12px_rgb(0_0_0/0.9)] transition duration-300 outline-none hover:-translate-y-1 hover:border-primary/70 hover:shadow-[0_0_0_1px_var(--color-primary),0_0_32px_-4px_rgb(139_92_246/0.55),0_18px_30px_-12px_rgb(0_0_0/0.9)] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      aria-label={empty ? `${system.name}: no games yet` : `${system.name}: ${count(games, "game")}, ${count(copies, "copy", "copies")}`}
    >
      {/* Diagonal colour bands in the system's accent. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-80"
        style={{
          background: `linear-gradient(115deg, transparent 52%, ${accent}26 52%, ${accent}26 60%, transparent 60%, transparent 63%, ${accent}40 63%, ${accent}40 67%, transparent 67%), radial-gradient(90% 90% at 85% 100%, ${accent}22, transparent 70%)`,
        }}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-linear-to-b from-white/[0.06] to-transparent" />

      <div className="relative z-10 flex h-full flex-col justify-between p-4 sm:p-5">
        <div className="drop-shadow-[0_2px_6px_rgb(0_0_0/0.8)]">
          <p className="text-[0.7rem] font-medium tracking-[0.18em] text-muted-foreground uppercase">{system.maker}</p>
          <p
            className="mt-0.5 bg-clip-text text-2xl leading-[0.95] font-black tracking-tight text-transparent uppercase italic sm:text-[1.7rem]"
            style={{ backgroundImage: `linear-gradient(180deg, #ffffff 10%, ${accentLight})` }}
          >
            {system.shortName}
          </p>
        </div>
        {empty ? (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-white/25 bg-black/45 px-2.5 py-1.5 text-sm font-medium text-muted-foreground backdrop-blur-sm transition-colors group-hover:border-primary/60 group-hover:text-foreground">
            <Plus aria-hidden="true" className="size-4 text-primary-text" />
            Start this shelf
          </span>
        ) : (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-white/10 bg-black/55 px-2.5 py-1.5 text-sm font-medium backdrop-blur-sm">
            <Gamepad2 aria-hidden="true" className="size-4 text-primary-text" />
            {count(games, "game")}
          </span>
        )}
      </div>

      <ConsoleArt
        kind={system.console}
        sizes="(min-width: 1280px) 260px, (min-width: 640px) 30vw, 60vw"
        style={consoleTileBox(system.console)}
        className={cn(
          "absolute right-[5%] bottom-[8%] origin-bottom drop-shadow-[0_12px_14px_rgb(0_0_0/0.65)] transition duration-300 group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100",
          // An empty shelf's console waits in the dark until its first game arrives.
          empty && "opacity-55 saturate-50 group-hover:opacity-90 group-hover:saturate-100",
        )}
      />
    </Link>
  );
}
