import { useCircuitStore } from '../store/circuitStore'
import type { NodeType } from '../types/circuit'

const ITEMS: { type: NodeType; label: string; kbd: string; icon: React.ReactNode }[] = [
  {
    type: 'vsource',
    label: 'Source',
    kbd: 'S',
    icon: (
      <svg viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="10" className="sym" fill="none" />
        <path d="M 10 16 q 3 -6 6 0 q 3 6 6 0" className="sym" fill="none" />
      </svg>
    ),
  },
  {
    type: 'busbar',
    label: 'Busbar',
    kbd: 'B',
    icon: (
      <svg viewBox="0 0 32 32">
        <rect x="2" y="13" width="28" height="6" className="sym-fill" />
      </svg>
    ),
  },
  {
    type: 'transformer',
    label: 'Transformer',
    kbd: 'T',
    icon: (
      <svg viewBox="0 0 32 32">
        <circle cx="16" cy="11" r="8" className="sym" fill="none" />
        <circle cx="16" cy="21" r="8" className="sym" fill="none" />
      </svg>
    ),
  },
  {
    type: 'regulator',
    label: 'Regulator',
    kbd: 'V',
    icon: (
      <svg viewBox="0 0 32 32">
        <circle cx="16" cy="11" r="8" className="sym" fill="none" />
        <circle cx="16" cy="21" r="8" className="sym" fill="none" />
        <line x1="4" y1="26" x2="28" y2="6" className="sym" />
        <path d="M28 6 L21 7.5 L25.5 12 Z" className="sym" fill="currentColor" />
      </svg>
    ),
  },
  {
    type: 'breaker',
    label: 'Breaker',
    kbd: 'K',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="16" y1="2" x2="16" y2="10" className="sym" />
        <rect x="10" y="10" width="12" height="12" className="sym-fill" />
        <line x1="16" y1="22" x2="16" y2="30" className="sym" />
      </svg>
    ),
  },
  {
    type: 'fuse',
    label: 'Fuse',
    kbd: 'F',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="16" y1="2" x2="16" y2="9" className="sym" />
        <rect x="9" y="9" width="14" height="14" className="sym" fill="none" />
        <line x1="16" y1="9" x2="16" y2="23" className="sym" />
        <line x1="16" y1="23" x2="16" y2="30" className="sym" />
      </svg>
    ),
  },
  {
    type: 'recloser',
    label: 'Recloser',
    kbd: 'O',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="16" y1="2" x2="16" y2="8" className="sym" />
        <circle cx="16" cy="16" r="8" className="sym" fill="none" />
        <line x1="16" y1="8" x2="16" y2="24" className="sym" />
        <line x1="16" y1="24" x2="16" y2="30" className="sym" />
      </svg>
    ),
  },
  {
    type: 'relay',
    label: 'Relay',
    kbd: 'Y',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="14" y1="4" x2="14" y2="12" className="sym" />
        <rect x="8" y="12" width="12" height="12" className="sym-fill" />
        <line x1="14" y1="24" x2="14" y2="30" className="sym" />
        <circle cx="24" cy="8" r="6" className="sym" fill="none" />
      </svg>
    ),
  },
  {
    type: 'load',
    label: 'Load',
    kbd: 'L',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="16" y1="2" x2="16" y2="12" className="sym" />
        <polygon points="9,12 23,12 16,28" className="sym-fill" />
      </svg>
    ),
  },
  {
    type: 'capacitor',
    label: 'Capacitor',
    kbd: 'C',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="16" y1="2" x2="16" y2="12" className="sym" />
        <line x1="7" y1="12" x2="25" y2="12" className="sym" />
        <line x1="7" y1="18" x2="25" y2="18" className="sym" />
        <line x1="16" y1="18" x2="16" y2="26" className="sym" />
        <line x1="10" y1="26" x2="22" y2="26" className="sym" />
        <line x1="13" y1="30" x2="19" y2="30" className="sym" />
      </svg>
    ),
  },
  {
    type: 'generator',
    label: 'Generator',
    kbd: 'G',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="16" y1="2" x2="16" y2="8" className="sym" />
        <circle cx="16" cy="19" r="10" className="sym" fill="none" />
        <text x="16" y="24" textAnchor="middle" className="sym-text" fontSize="11">
          G
        </text>
      </svg>
    ),
  },
  {
    type: 'pvsystem',
    label: 'PV system',
    kbd: 'P',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="16" y1="2" x2="16" y2="8" className="sym" />
        <circle cx="16" cy="19" r="10" className="sym" fill="none" />
        <line x1="2" y1="6" x2="7" y2="11" className="sym" />
        <line x1="7" y1="3" x2="10" y2="9" className="sym" />
        <text x="16" y="23" textAnchor="middle" className="sym-text" fontSize="9">
          PV
        </text>
      </svg>
    ),
  },
  {
    type: 'storage',
    label: 'Storage',
    kbd: 'A',
    icon: (
      <svg viewBox="0 0 32 32">
        <line x1="16" y1="2" x2="16" y2="12" className="sym" />
        <line x1="6" y1="12" x2="26" y2="12" className="sym" />
        <line x1="11" y1="17" x2="21" y2="17" className="sym" />
        <line x1="6" y1="22" x2="26" y2="22" className="sym" />
        <line x1="11" y1="27" x2="21" y2="27" className="sym" />
      </svg>
    ),
  },
]

export function Palette() {
  const placementType = useCircuitStore((s) => s.placementType)
  const setPlacement = useCircuitStore((s) => s.setPlacement)
  const connectMode = useCircuitStore((s) => s.connectMode)
  const setConnectMode = useCircuitStore((s) => s.setConnectMode)

  return (
    <div className="palette">
      <div className="palette-group">
        <div className="palette-title">Components</div>
        {ITEMS.map((item) => (
          <button
            key={item.type}
            className={`palette-item${placementType === item.type ? ' active' : ''}`}
            onClick={() => setPlacement(placementType === item.type ? null : item.type)}
            title={`Click (or press ${item.kbd}), then click the canvas to place a ${item.label.toLowerCase()}`}
          >
            <span className="palette-icon">{item.icon}</span>
            <span className="palette-label">{item.label}</span>
            <kbd className="palette-kbd">{item.kbd}</kbd>
          </button>
        ))}
      </div>
      <div className="palette-group">
        <div className="palette-title">Drag to connect</div>
        <button
          className={`palette-item${connectMode === 'wire' ? ' active' : ''}`}
          onClick={() => setConnectMode('wire')}
          title="New connections are ideal wires (same electrical bus)"
        >
          <span className="palette-icon">
            <svg viewBox="0 0 32 32">
              <line x1="2" y1="16" x2="30" y2="16" className="sym" />
            </svg>
          </span>
          <span className="palette-label">Wire</span>
          <kbd className="palette-kbd">W</kbd>
        </button>
        <button
          className={`palette-item${connectMode === 'line' ? ' active' : ''}`}
          onClick={() => setConnectMode('line')}
          title="New connections are OpenDSS Line elements (impedance + length)"
        >
          <span className="palette-icon">
            <svg viewBox="0 0 32 32">
              <line x1="2" y1="16" x2="30" y2="16" className="sym" strokeWidth="3" />
            </svg>
          </span>
          <span className="palette-label">Line</span>
          <kbd className="palette-kbd">E</kbd>
        </button>
      </div>
      {placementType && (
        <div className="palette-hint">Click the canvas to place. Esc to cancel.</div>
      )}
    </div>
  )
}
