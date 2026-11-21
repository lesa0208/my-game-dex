import type { ConsoleKind } from "@/features/shelf/browse";
import { cn } from "@/lib/utils";

// Original, stylized console drawings (no logos or photographs), one per hardware
// family, in a shared 200 × 120 frame. Decorative: the system's name is always shown as
// text beside them.

function Shadow() {
  return <ellipse cx="100" cy="112" rx="88" ry="6" fill="rgb(0 0 0 / 0.45)" />;
}

function Defs({ id, light, dark }: { id: string; light: string; dark: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={light} />
        <stop offset="1" stopColor={dark} />
      </linearGradient>
    </defs>
  );
}

const DRAWINGS: Record<ConsoleKind, React.ReactNode> = {
  snes: (
    <>
      <Defs id="c-snes" light="#d9d6e0" dark="#a7a3b3" />
      <Shadow />
      <path d="M18 62Q18 52 28 52H140Q150 52 150 62V96Q150 104 142 104H26Q18 104 18 96Z" fill="url(#c-snes)" />
      <path d="M34 40Q34 34 40 34H128Q134 34 134 40V54H34Z" fill="#c3bfcd" />
      <rect x="58" y="31" width="52" height="6" rx="2" fill="#3a3743" />
      <rect x="36" y="64" width="16" height="8" rx="2" fill="#7c5cc4" />
      <rect x="116" y="64" width="16" height="8" rx="2" fill="#7c5cc4" />
      <rect x="64" y="66" width="40" height="3" rx="1.5" fill="rgb(0 0 0 / 0.18)" />
      <path d="M18 80H150" stroke="rgb(0 0 0 / 0.12)" />
      {/* Controller */}
      <path d="M118 92Q118 82 132 82H170Q184 82 184 92Q184 106 170 106Q160 106 156 100H146Q142 106 132 106Q118 106 118 92Z" fill="#d4d1db" stroke="rgb(0 0 0 / 0.15)" />
      <path d="M128 92h8M132 88v8" stroke="#3a3743" strokeWidth="3" strokeLinecap="round" />
      <circle cx="166" cy="88" r="2.6" fill="#8b5cf6" />
      <circle cx="172" cy="93" r="2.6" fill="#a78bfa" />
      <circle cx="160" cy="93" r="2.6" fill="#6d28d9" />
      <circle cx="166" cy="98" r="2.6" fill="#c4b5fd" />
    </>
  ),
  nes: (
    <>
      <Defs id="c-nes" light="#d6d4d8" dark="#b3b0b6" />
      <Shadow />
      <rect x="20" y="44" width="140" height="34" rx="3" fill="url(#c-nes)" />
      <rect x="20" y="76" width="140" height="28" rx="2" fill="#2a2a2e" />
      <rect x="40" y="50" width="84" height="22" rx="1" fill="#c9c7cc" stroke="rgb(0 0 0 / 0.15)" />
      <rect x="30" y="84" width="10" height="6" rx="1" fill="#d23f3f" />
      <rect x="44" y="84" width="10" height="6" rx="1" fill="#9c9aa0" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <line key={i} x1="100" x2="152" y1={82 + i * 3.4} y2={82 + i * 3.4} stroke="rgb(255 255 255 / 0.08)" />
      ))}
      {/* Controller */}
      <rect x="128" y="88" width="56" height="20" rx="2" fill="#1f1f23" stroke="#b3b0b6" />
      <path d="M136 98h8M140 94v8" stroke="#9c9aa0" strokeWidth="2.6" />
      <circle cx="168" cy="99" r="2.6" fill="#d23f3f" />
      <circle cx="176" cy="99" r="2.6" fill="#d23f3f" />
    </>
  ),
  gameboy: (
    <>
      <Defs id="c-gb" light="#d8d6db" dark="#b4b1b8" />
      <Shadow />
      <path d="M68 6Q68 2 72 2H128Q132 2 132 6V100Q132 112 120 112H72Q68 112 68 108Z" fill="url(#c-gb)" />
      <rect x="76" y="12" width="48" height="40" rx="3" fill="#4b4d5a" />
      <rect x="85" y="18" width="30" height="27" fill="#9bbc4c" />
      <rect x="85" y="18" width="30" height="27" fill="url(#c-gb)" opacity="0.12" />
      <path d="M78 74h12M84 68v12" stroke="#2d2d33" strokeWidth="4" strokeLinecap="round" />
      <circle cx="112" cy="76" r="4" fill="#8e3a6b" />
      <circle cx="122" cy="70" r="4" fill="#8e3a6b" />
      {[0, 1, 2, 3].map((i) => (
        <line key={i} x1={108 + i * 4} y1="104" x2={114 + i * 4} y2="96" stroke="rgb(0 0 0 / 0.25)" strokeWidth="1.4" />
      ))}
    </>
  ),
  n64: (
    <>
      <Defs id="c-n64" light="#4e505a" dark="#24252b" />
      <Shadow />
      <path d="M16 76Q16 62 30 60L70 54H130L170 60Q184 62 184 76V96Q184 104 176 104H24Q16 104 16 96Z" fill="url(#c-n64)" />
      <path d="M66 54Q66 40 80 40H120Q134 40 134 54Z" fill="#3b3d45" />
      <rect x="82" y="44" width="36" height="6" rx="2" fill="#15161a" />
      <circle cx="50" cy="76" r="5" fill="#2f3037" stroke="rgb(255 255 255 / 0.12)" />
      <circle cx="150" cy="76" r="5" fill="#2f3037" stroke="rgb(255 255 255 / 0.12)" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={70 + i * 16} y="92" width="10" height="5" rx="1" fill="#16171b" />
      ))}
    </>
  ),
  megadrive: (
    <>
      <Defs id="c-md" light="#3a3b42" dark="#121216" />
      <Shadow />
      <path d="M14 70Q14 56 30 54H170Q186 56 186 70V96Q186 104 178 104H22Q14 104 14 96Z" fill="url(#c-md)" />
      <circle cx="100" cy="66" r="24" fill="#1d1e23" stroke="rgb(255 255 255 / 0.1)" />
      <circle cx="100" cy="66" r="15" fill="none" stroke="#c0392b" strokeWidth="2" opacity="0.85" />
      <rect x="84" y="62" width="32" height="7" rx="2" fill="#09090b" />
      <rect x="30" y="88" width="34" height="5" rx="2" fill="rgb(255 255 255 / 0.08)" />
      <circle cx="160" cy="90" r="3" fill="#c0392b" />
    </>
  ),
  playstation: (
    <>
      <Defs id="c-ps" light="#d5d4d9" dark="#a9a8b0" />
      <Shadow />
      <rect x="22" y="48" width="156" height="56" rx="6" fill="url(#c-ps)" />
      <circle cx="96" cy="74" r="22" fill="#c4c3ca" stroke="rgb(0 0 0 / 0.16)" />
      <circle cx="96" cy="74" r="5" fill="#b2b1b9" />
      <circle cx="38" cy="66" r="5" fill="#b5b4bc" stroke="rgb(0 0 0 / 0.2)" />
      <circle cx="152" cy="66" r="5" fill="#b5b4bc" stroke="rgb(0 0 0 / 0.2)" />
      <rect x="132" y="88" width="30" height="5" rx="2" fill="rgb(0 0 0 / 0.14)" />
      <rect x="34" y="88" width="30" height="5" rx="2" fill="rgb(0 0 0 / 0.14)" />
    </>
  ),
  saturn: (
    <>
      <Defs id="c-sat" light="#4a4b53" dark="#1f2025" />
      <Shadow />
      <rect x="20" y="50" width="160" height="54" rx="8" fill="url(#c-sat)" />
      <circle cx="100" cy="74" r="24" fill="#2b2c32" stroke="rgb(255 255 255 / 0.1)" />
      <circle cx="100" cy="74" r="6" fill="#3a3b42" />
      <rect x="32" y="62" width="22" height="6" rx="3" fill="#15161a" />
      <rect x="146" y="62" width="22" height="6" rx="3" fill="#15161a" />
      <rect x="40" y="90" width="14" height="5" rx="2" fill="#6b7280" />
    </>
  ),
};

export function ConsoleArt({ kind, className }: { kind: ConsoleKind; className?: string }) {
  return (
    <svg viewBox="0 0 200 120" aria-hidden="true" className={cn("w-full", className)}>
      {DRAWINGS[kind]}
    </svg>
  );
}
