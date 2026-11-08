"""M16 core: sectionalizers and reclose intervals in the compiler, the extra
reliability indices (MAIFI, ASAI, CEMI, ASIFI, outage cost)."""
from pathlib import Path


def patch(path: str, pairs: list[tuple[str, str]]) -> None:
    p = Path(path)
    s = p.read_text(encoding="utf-8")
    for old, new in pairs:
        assert old in s, f"{path}: anchor missing: {old[:70]!r}"
        s = s.replace(old, new, 1)
    p.write_text(s, encoding="utf-8")


# --- compiler: reclose intervals; a sectionalizer as a never-tripping relay ------------------
patch("src/opendss_designer/core/compiler.py", [
    ('''               f"numfast={int(_num(p, 'numfast', 1.0) or 1)} "
               f"shots={int(_num(p, 'shots', 4.0) or 4)} "
               f"delay={_num(p, 'delay', 0.0):g}")''',
     '''               f"numfast={int(_num(p, 'numfast', 1.0) or 1)} "
               f"shots={int(_num(p, 'shots', 4.0) or 4)} "
               f"delay={_num(p, 'delay', 0.0):g}")
        intervals = p.get("recloseintervals")
        if isinstance(intervals, list) and intervals:
            try:
                cmd += " recloseintervals=(" + ", ".join(f"{float(v):g}" for v in intervals[:8]) + ")"
            except (TypeError, ValueError):
                pass'''),
    ('''    for n in breakers:
        p = n.params
        name = element_name("line", p.get("name"), n.id, n.id)
        phases = _phases(p)
        b1, b2 = conn.node_buses[n.id]
        sfx = _bus_suffix(p.get("busNodes"), phases, p.get("phasing"))
        normamps = _num(p, "normamps", DEFAULT_BREAKER_NORMAMPS)
        cmds.append(
            f"new line.{name} bus1={b1}{sfx} bus2={b2}{sfx} phases={phases} "
            f"switch=yes{_switch_impedance(p)} normamps={normamps:g}{_reliability(p)}"
            f"{_emergency(p, 'line')}")
        if not p.get("closed", True):
            cmds.append(f"open line.{name} term=1")''',
     '''    for n in breakers:
        p = n.params
        name = element_name("line", p.get("name"), n.id, n.id)
        phases = _phases(p)
        b1, b2 = conn.node_buses[n.id]
        sfx = _bus_suffix(p.get("busNodes"), phases, p.get("phasing"))
        normamps = _num(p, "normamps", DEFAULT_BREAKER_NORMAMPS)
        cmds.append(
            f"new line.{name} bus1={b1}{sfx} bus2={b2}{sfx} phases={phases} "
            f"switch=yes{_switch_impedance(p)} normamps={normamps:g}{_reliability(p)}"
            f"{_emergency(p, 'line')}")
        if p.get("sectionalizer") is True and p.get("closed", True):
            # A sectionalizer opens during the upstream recloser's dead time
            # after a count of fault interruptions; it carries no curve and
            # never interrupts fault current itself. OpenDSS has no class for
            # it, so for the reliability sections it heads it is a relay that
            # never trips on current (a pickup nothing reaches), which the
            # coordination study leaves out and the EnergyMeter counts.
            cmds.append(
                f"new relay.{name} monitoredobj=line.{name} monitoredterm=1 "
                f"switchedobj=line.{name} switchedterm=1 type=current "
                f"phasecurve=definite phasetrip=1e9 delay=0")
            res.element_map[f"relay.{name}"] = n.id
        if not p.get("closed", True):
            cmds.append(f"open line.{name} term=1")'''),
])

# --- protection: leave sectionalizer relays out of the plot and the checks ----------------
patch("src/opendss_designer/core/protection.py", [(
    '''        if dev and _prop(full, "type").lower().startswith("current"):''',
    '''        # A sectionalizer compiles as a relay with a pickup nothing reaches
        # (see the compiler); it has no curve to plot or grade.
        if dev and _prop_float(full, "phasetrip") >= 1e8:
            i = dss.Relays.Next()
            continue
        if dev and _prop(full, "type").lower().startswith("current"):''',
)])

# --- reliability: MAIFI, ASAI, CEMI, ASIFI, outage cost -----------------------------------
patch("src/opendss_designer/core/reliability.py", [
    ('''def reliability_study(circuit: Circuit) -> dict[str, Any]:''', '''# Customer interruption cost by load class, dollars per sustained
# interruption per customer and per customer-hour: order-of-magnitude
# defaults in the range of the US DOE ICE Calculator, to be replaced by a
# utility's own figures (`outageCost` in the study options).
DEFAULT_OUTAGE_COST: dict[str, dict[str, float]] = {
    "residential": {"perInterruption": 4.0, "perHour": 3.0},
    "commercial": {"perInterruption": 1200.0, "perHour": 400.0},
    "industrial": {"perInterruption": 10000.0, "perHour": 3000.0},
    "default": {"perInterruption": 50.0, "perHour": 20.0},
}


def extra_indices(circuit: Circuit, result: dict[str, Any],
                  outage_cost: dict[str, dict[str, float]] | None = None) -> dict[str, Any]:
    """MAIFI, ASAI, CEMI and ASIFI, and the customers' interruption cost,
    from the sections the study found and the loads below each.

    * MAIFI counts momentary interruptions: the temporary share of a
      section's faults (fault rate less the permanent share) interrupts
      every customer below the recloser that clears them, when the
      section is headed by a recloser; fuses and relays make every fault a
      sustained one.
    * ASAI is the availability, 1 - SAIDI / 8760.
    * CEMI_n is the share of customers whose expected interruptions a year
      exceed n (the expectation, not a draw): every load sees the permanent
      faults of its own section and of every section above it.
    * ASIFI weights the same by load kW instead of customers.
    """
    sections = result.get("sections") or []
    elements = result.get("elements") or {}
    total_cust = result.get("totalCustomers") or 0
    if not sections or not total_cust:
        return {"maifi": None, "asai": None, "cemi": {}, "asifi": None, "outageCost": None}
    from .connectivity import synthesize
    from .model import conducts, in_service
    conn = synthesize(circuit)
    # Downstream buses of each section head, by a walk from the head's far
    # terminal that stops at other heads.
    heads = {s["headId"]: s for s in sections if s.get("headId")}
    adjacency: dict[str, list[tuple[str, str | None]]] = {}
    for n in circuit.nodes:
        if n.type in ("transformer", "regulator", "breaker", "fuse", "recloser", "relay") and conducts(n):
            buses = [b.lower() for b in conn.node_buses.get(n.id, [])]
            for a in buses:
                for b in buses:
                    if a != b:
                        adjacency.setdefault(a, []).append((b, n.id))
    for eid, (b1, b2) in conn.line_buses.items():
        e = next((x for x in circuit.edges if x.id == eid), None)
        if e is not None and not in_service(e.params):
            continue
        adjacency.setdefault(b1.lower(), []).append((b2.lower(), eid))
        adjacency.setdefault(b2.lower(), []).append((b1.lower(), eid))
    source_buses = {conn.node_buses[n.id][0].lower() for n in circuit.nodes if n.type == "vsource" and n.id in conn.node_buses}
    # Parent of every bus from the source, so "below a head" is well defined.
    parent: dict[str, tuple[str | None, str | None]] = {}
    queue = list(source_buses)
    for b in queue:
        parent[b] = (None, None)
    while queue:
        bus = queue.pop(0)
        for nb, via in adjacency.get(bus, ()):
            if nb not in parent:
                parent[nb] = (bus, via)
                queue.append(nb)
    # Loads: bus, customers, kW, class, and the heads on the path to the source.
    loads = []
    for n in circuit.nodes:
        if n.type != "load" or not in_service(n.params) or n.id not in conn.node_buses:
            continue
        bus = conn.node_buses[n.id][0].lower()
        try:
            cust = int(float(n.params.get("numcust", 1) or 1))
            kw = float(n.params.get("kw", 100) or 100)
        except (TypeError, ValueError):
            cust, kw = 1, 100.0
        path_heads: list[str] = []
        b: str | None = bus
        guard = 0
        while b is not None and guard < 100000:
            pb, via = parent.get(b, (None, None))
            if via in heads:
                path_heads.append(via)
            b = pb
            guard += 1
        loads.append({"id": n.id, "cust": cust, "kw": kw, "cls": str(n.params.get("class") or "").strip().lower(),
                      "heads": path_heads})
    lam = {s["headId"]: s["lambda"] for s in sections if s.get("headId")}
    repair = {s["headId"]: (s.get("avgRepairHrs") or 0.0) for s in sections if s.get("headId")}
    total_kw = sum(ld["kw"] for ld in loads) or 1.0
    freq_cust = 0.0
    kw_int = 0.0
    cemi_thresholds = (1, 2, 3, 5)
    cemi_cust = dict.fromkeys(cemi_thresholds, 0)
    cost_total = 0.0
    rates = {**DEFAULT_OUTAGE_COST, **(outage_cost or {})}
    for ld in loads:
        f = sum(lam.get(h, 0.0) for h in ld["heads"])
        hours = sum(lam.get(h, 0.0) * repair.get(h, 0.0) for h in ld["heads"])
        freq_cust += f * ld["cust"]
        kw_int += f * ld["kw"]
        for t in cemi_thresholds:
            if f > t:
                cemi_cust[t] += ld["cust"]
        rate = rates.get(ld["cls"]) or rates["default"]
        cost_total += ld["cust"] * (f * rate["perInterruption"] + hours * rate["perHour"])
    # Momentary interruptions below reclosers: the temporary faults of each
    # recloser-headed section, times the customers below the recloser.
    temp_rate: dict[str, float] = {}
    for full, el in elements.items():
        sec = el.get("sectionId")
        if not sec:
            continue
        temporary = max(0.0, el.get("faultRate", 0.0) * (1 - el.get("pctPerm", 20.0) / 100.0))
        # The element's permanent lambda already includes its exposure
        # (length); the engine gives faultRate per unit length for lines,
        # so scale by the same ratio permanent/faultRate where it can.
        perm = el.get("lambda", 0.0)
        fr = el.get("faultRate", 0.0)
        pp = el.get("pctPerm", 20.0) / 100.0
        exposure = (perm / (fr * pp)) if fr > 0 and pp > 0 else 1.0
        temp_rate[sec] = temp_rate.get(sec, 0.0) + temporary * exposure
    momentary = 0.0
    for s in sections:
        if s.get("device") == "recloser":
            momentary += temp_rate.get(s["id"], 0.0) * s["totalCustomers"]
    saidi = result.get("saidi")
    return {
        "maifi": round(momentary / total_cust, 4),
        "asai": round(1 - saidi / 8760.0, 6) if saidi is not None else None,
        "cemi": {str(t): round(cemi_cust[t] / total_cust, 4) for t in cemi_thresholds},
        "asifi": round(kw_int / total_kw, 4),
        "outageCost": round(cost_total, 0),
        "outageCostRates": rates,
        "loadsConsidered": len(loads),
    }


def reliability_study(circuit: Circuit) -> dict[str, Any]:'''),
])
# hook the extras onto the study's return: find the final return of reliability_study
p = Path("src/opendss_designer/core/reliability.py")
s = p.read_text(encoding="utf-8")
anchor = '    return {\n        "converged": converged,'
assert anchor in s, "reliability return"
idx = s.rindex(anchor)
# find the matching closing of that dict: the return ends at the first "\n    }\n" after idx
end = s.index("\n    }\n", idx)
ret = s[idx:end + 6]
new_ret = ret.replace('    return {\n        "converged": converged,', '    out = {\n        "converged": converged,', 1)
new_ret += '''    if converged:
        try:
            out.update(extra_indices(circuit, out))
        except Exception as exc:  # the extras must never sink the study
            issues.append(Issue(severity="warning", code="reliability-extras",
                                message=f"MAIFI/ASAI/CEMI could not be computed: {exc}"))
            out["issues"] = [i.model_dump() for i in issues]
    return out
'''
s = s[:idx] + new_ret + s[end + 6:]
p.write_text(s, encoding="utf-8")
print("m16 core patched")
