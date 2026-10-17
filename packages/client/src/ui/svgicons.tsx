/** Small line icons for HUD buttons. */
const P = {
  inventory: 'M7 8V6a5 5 0 0 1 10 0v2M4 8h16l-1 12H5L4 8zm5 4h6',
  character: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0',
  skills: 'M12 2l2.6 6.6L21 9l-5 4.4L17.4 21 12 17.3 6.6 21 8 13.4 3 9l6.4-.4z',
  quests: 'M6 3h10l3 3v15H6zM9 8h7M9 12h7M9 16h4',
  map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15',
  menu: 'M4 6h16M4 12h16M4 18h16',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7v.5M12 17h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  craft: 'M14 6l4 4-9 9-4-4zM16 4l4 4M4 20l2-2',
  codex: 'M4 5a2 2 0 0 1 2-2h5v17H6a2 2 0 0 0-2 2zM20 5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 1 2 2zM7 8h2M15 8h2M7 12h2M15 12h2',
};

export function Icon({ name, size = 18 }: { name: keyof typeof P; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--gold-2)' }}>
      <path d={P[name]} />
    </svg>
  );
}
