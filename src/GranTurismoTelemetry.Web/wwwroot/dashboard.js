/* eslint-disable no-undef */
(function () {
    "use strict";

    // ----- Config -----------------------------------------------------------
    const HUB_URL     = "/hubs/telemetry";
    const STATUS_URL  = "/api/telemetry/status";
    const SHIFT_LIGHT_COUNT = 15;

    // Flag bit values must match SimulatorFlags in TelemetryPacket.cs
    const FLAG_ON_TRACK    = 1 << 0;
    const FLAG_PAUSED      = 1 << 1;
    const FLAG_IN_GEAR     = 1 << 3;
    const FLAG_TURBO       = 1 << 4;
    const FLAG_REV_LIMITER = 1 << 5;
    const FLAG_HANDBRAKE   = 1 << 6;
    const FLAG_LIGHTS      = 1 << 7;
    const FLAG_ASM         = 1 << 10;
    const FLAG_TCS         = 1 << 11;

    // ----- DOM cache --------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const el = {
        connDot: $("conn-dot"), connText: $("conn-text"),
        modeText: $("mode-text"), ipText: $("ip-text"),
        diagText: $("diag-text"),
        staleBanner: $("stale-banner"), staleHint: $("stale-hint"),
        unitKmh: $("unit-kmh"), unitMph: $("unit-mph"),
        tempC: $("temp-c"), tempF: $("temp-f"),
        rpmFill: $("rpm-fill"), rpmLights: $("rpm-lights"),
        gear: $("gear"), rpm: $("rpm"),
        speed: $("speed"), speedUnit: $("speed-unit"),
        throttleBar: $("throttle-bar"), throttleVal: $("throttle-val"),
        brakeBar: $("brake-bar"), brakeVal: $("brake-val"),
        clutchBar: $("clutch-bar"), clutchVal: $("clutch-val"),
        lap: $("lap"), position: $("position"),
        lastLap: $("last-lap"), bestLap: $("best-lap"),
        tireFL: $("tire-fl"), tireFR: $("tire-fr"),
        tireRL: $("tire-rl"), tireRR: $("tire-rr"),
        fuelBar: $("fuel-bar"), fuelPct: $("fuel-pct"),
        gaugeGrid: $("gauges"),
        flags: document.querySelectorAll(".flag[data-flag]"),
        menuBtn: $("menu-btn"),
        sidebar: $("sidebar"),
        sidebarClose: $("sidebar-close"),
        sidebarBackdrop: $("sidebar-backdrop"),
        dash: $("dash"),
        dashEmpty: $("dash-empty"),
        emptyOpenMenu: $("empty-open-menu"),
        panelToggles: document.querySelectorAll(".panel-toggle[data-panel]"),
        panels: document.querySelectorAll(".dash > .panel[data-panel]"),
    };

    // ----- State ------------------------------------------------------------
    let unit = localStorage.getItem("gt7.unit") || "kmh";
    let tempUnit = localStorage.getItem("gt7.tempUnit") === "f" ? "f" : "c";
    let lastPacket = null;
    buildShiftLights();

    let redlineRpm = 8500;
    let shiftBeginRpm = 6800; // fills the shift lights from this RPM upward

    // Simple exponential smoother for RPM/speed (keeps needle glassy).
    let smoothRpm = 0, smoothSpeed = 0;
    const SMOOTH_ALPHA = 0.35;

    const GAUGE_ALPHA = 0.18;
    // Gradient, cornering load and wheel slip are noisier than the fluid
    // temperatures, so they get their own, slower smoothers.
    const INCLINE_ALPHA = 0.10;
    const CHASSIS_ALPHA = 0.15;
    // Below these speeds the derived values (gradient, slip, cornering g) are
    // meaningless, so those dials read zero instead of showing noise.
    const MIN_HORIZ_MPS  = 1.5;
    const MIN_MOTION_MPS = 2.0;

    const ZONE_CLASSES = ["zone-cold", "zone-good", "zone-warn", "zone-hot"];
    // The 180° arc every mini gauge is drawn on: centre (70, 78), radius 58.
    const GAUGE_ARC = "M 12 78 A 58 58 0 0 1 128 78";

    // Every telemetry value that reads naturally on a dial lives here; the
    // cards are generated from this list, so a new gauge is one entry.
    //   read      - raw value pulled from the packet
    //   tick      - optional marker at this fraction of the 180° sweep
    //   zoneValue - value the colour zones are picked from (default: read)
    //   alpha     - smoothing factor (default: GAUGE_ALPHA)
    //   temp      - unit label follows the °C / °F toggle
    //   na        - when true the dial greys out and shows N/A
    const GAUGE_SPECS = [
        {
            key: "boost", label: "BOOST", unit: "bar",
            min: -1, max: 2, tick: 0.83,
            read: p => p.boostBar ?? 0,
            format: v => v.toFixed(2),
            na: p => (p.flags & FLAG_TURBO) === 0,
            zones: [
                { under: 0,   cls: "zone-cold" },
                { under: 1.5, cls: "zone-good" },
                {             cls: "zone-warn" },
            ],
        },
        {
            key: "incline", label: "INCLINE", unit: "°",
            min: -20, max: 20, tick: 0.5, alpha: INCLINE_ALPHA,
            read: inclineDeg,
            format: v => (v >= 0 ? "+" : "") + v.toFixed(1),
            zoneValue: v => Math.abs(v),
            zones: [
                { under: 5,  cls: "zone-good" },
                { under: 10, cls: "zone-warn" },
                {            cls: "zone-hot"  },
            ],
        },
        {
            key: "altitude", label: "ALTITUDE", unit: "m",
            min: 0, max: 1200,
            read: p => p.positionY ?? 0,
            format: v => String(Math.round(v)),
            zones: [{ cls: "zone-good" }],
        },
        {
            key: "lat-g", label: "CORNERING", unit: "g",
            min: -3, max: 3, tick: 0.5, alpha: CHASSIS_ALPHA,
            read: lateralG,
            format: v => (v >= 0 ? "+" : "") + v.toFixed(2),
            zoneValue: v => Math.abs(v),
            zones: [
                { under: 0.8, cls: "zone-good" },
                { under: 1.6, cls: "zone-warn" },
                {             cls: "zone-hot"  },
            ],
        },
        {
            key: "slip", label: "WHEEL SLIP", unit: "%",
            min: -40, max: 40, tick: 0.5, alpha: CHASSIS_ALPHA,
            read: wheelSlipPct,
            format: v => (v >= 0 ? "+" : "") + v.toFixed(0),
            zoneValue: v => Math.abs(v),
            zones: [
                { under: 4,  cls: "zone-good" },
                { under: 12, cls: "zone-warn" },
                {            cls: "zone-hot"  },
            ],
        },
        {
            key: "ride", label: "RIDE HEIGHT", unit: "mm",
            min: 0, max: 200,
            read: p => (p.rideHeight ?? 0) * 1000,
            format: v => String(Math.round(v)),
            zones: [{ cls: "zone-good" }],
        },
    ];

    // key -> { spec, box, fill, value, unit, smooth }
    const gauges = {};
    buildGauges();
    setUnit(unit);
    setTempUnit(tempUnit);

    // ----- Unit toggles -----------------------------------------------------
    el.unitKmh.addEventListener("click", () => setUnit("kmh"));
    el.unitMph.addEventListener("click", () => setUnit("mph"));
    el.tempC.addEventListener("click", () => setTempUnit("c"));
    el.tempF.addEventListener("click", () => setTempUnit("f"));
    function setUnit(u) {
        unit = u;
        localStorage.setItem("gt7.unit", u);
        el.unitKmh.classList.toggle("active", u === "kmh");
        el.unitMph.classList.toggle("active", u === "mph");
        el.speedUnit.textContent = u === "kmh" ? "km/h" : "mph";
    }
    function setTempUnit(u) {
        tempUnit = u;
        localStorage.setItem("gt7.tempUnit", u);
        el.tempC.classList.toggle("active", u === "c");
        el.tempF.classList.toggle("active", u === "f");
        const label = u === "c" ? "°C" : "°F";
        for (const key in gauges) {
            const g = gauges[key];
            if (g.spec.temp) g.unit.textContent = label;
        }
        if (lastPacket) {
            setTire(el.tireFL, lastPacket.tireTempFL);
            setTire(el.tireFR, lastPacket.tireTempFR);
            setTire(el.tireRL, lastPacket.tireTempRL);
            setTire(el.tireRR, lastPacket.tireTempRR);
            for (const key in gauges) {
                const g = gauges[key];
                if (g.spec.temp) setGauge(g, g.smooth);
            }
        }
    }
    function toDisplayTemp(celsius) {
        return tempUnit === "f" ? (celsius * 9 / 5) + 32 : celsius;
    }

    // ----- Panel visibility + sidebar --------------------------------------
    const PANEL_STORAGE = "gt7.panels";
    const SIDEBAR_STORAGE = "gt7.sidebar";

    function loadPanelState() {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(PANEL_STORAGE) || "{}"); }
        catch (_) { saved = {}; }
        el.panelToggles.forEach((btn) => {
            const stored = saved[btn.dataset.panel];
            const on = stored === undefined ? true : !!stored;
            btn.setAttribute("aria-checked", on ? "true" : "false");
        });
        applyPanels();
    }

    function savePanelState() {
        const state = {};
        el.panelToggles.forEach((btn) => {
            state[btn.dataset.panel] = btn.getAttribute("aria-checked") === "true";
        });
        localStorage.setItem(PANEL_STORAGE, JSON.stringify(state));
    }

    function isPanelOn(id) {
        const btn = document.querySelector(`.panel-toggle[data-panel="${id}"]`);
        return !btn || btn.getAttribute("aria-checked") !== "false";
    }

    function applyPanels() {
        const visible = [];
        el.panels.forEach((panel) => {
            const on = isPanelOn(panel.dataset.panel);
            panel.hidden = !on;
            panel.classList.remove("span-full");
            if (on) visible.push(panel);
        });
        // Odd last panel spans the full row so a 1/3/5 layout has no empty cell.
        if (visible.length % 2 === 1) {
            visible[visible.length - 1].classList.add("span-full");
        }
        const empty = visible.length === 0;
        el.dash.classList.toggle("is-empty", empty);
        if (el.dashEmpty) el.dashEmpty.hidden = !empty;
        el.dash.dataset.count = String(visible.length);
    }

    el.sidebar.addEventListener("click", (e) => {
        const btn = e.target.closest(".panel-toggle[data-panel]");
        if (!btn || !el.sidebar.contains(btn)) return;
        const on = btn.getAttribute("aria-checked") !== "true";
        btn.setAttribute("aria-checked", on ? "true" : "false");
        savePanelState();
        applyPanels();
    });

    function setSidebarOpen(open) {
        document.body.classList.toggle("sidebar-open", open);
        el.menuBtn.setAttribute("aria-expanded", String(open));
        el.sidebar.setAttribute("aria-hidden", String(!open));
        el.sidebar.removeAttribute("inert");
        if (el.sidebarBackdrop) el.sidebarBackdrop.hidden = !open;
        localStorage.setItem(SIDEBAR_STORAGE, open ? "1" : "0");
    }

    el.menuBtn.addEventListener("click", () => {
        setSidebarOpen(!document.body.classList.contains("sidebar-open"));
    });
    if (el.sidebarClose) el.sidebarClose.addEventListener("click", () => setSidebarOpen(false));
    if (el.sidebarBackdrop) el.sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));
    if (el.emptyOpenMenu) el.emptyOpenMenu.addEventListener("click", () => setSidebarOpen(true));
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && document.body.classList.contains("sidebar-open")) {
            setSidebarOpen(false);
        }
    });

    setSidebarOpen(localStorage.getItem(SIDEBAR_STORAGE) === "1");
    loadPanelState();

    // ----- Shift lights -----------------------------------------------------
    function buildShiftLights() {
        el.rpmLights.innerHTML = "";
        for (let i = 0; i < SHIFT_LIGHT_COUNT; i++) {
            const d = document.createElement("div");
            d.className = "light";
            el.rpmLights.appendChild(d);
        }
    }

    // ----- Connection + telemetry-flow state --------------------------------
    // hubConnected: SignalR hub is up.
    // lastPacketMs: browser-side timestamp of the last telemetry event.
    // lastStatus:   most recent /api/telemetry/status snapshot (server side).
    const flow = { hubConnected: false, lastPacketMs: 0, lastStatus: null };
    const STALE_AFTER_MS = 2000; // "connected but no data" threshold

    // ----- Header status ----------------------------------------------------
    async function refreshStatus() {
        try {
            const r = await fetch(STATUS_URL);
            const s = await r.json();
            flow.lastStatus = s;
            el.modeText.textContent = s.mode === "simulator" ? "SIMULATOR" : "LIVE UDP";
            el.ipText.textContent = s.useSimulator
                ? "no PS5 (simulator)"
                : `PS5 ${s.ps5Ip} (recv :${s.receivePort})`;
            renderDiagnostics();
            renderConnectionUi();
        } catch (_) { /* ignore transient errors */ }
    }

    // ----- SignalR connection ----------------------------------------------
    const conn = new signalR.HubConnectionBuilder()
        .withUrl(HUB_URL)
        .withAutomaticReconnect([0, 500, 2000, 5000, 10000])
        .configureLogging(signalR.LogLevel.Warning)
        .build();

    conn.on("telemetry", (p) => {
        flow.lastPacketMs = Date.now();
        renderConnectionUi();
        onPacket(p);
    });
    conn.onreconnecting(() => { flow.hubConnected = false; renderConnectionUi("reconnecting…"); });
    conn.onreconnected (() => { flow.hubConnected = true;  renderConnectionUi(); });
    conn.onclose      (() => { flow.hubConnected = false; renderConnectionUi("disconnected"); });

    /**
     * Renders the header connection dot + text based on both:
     *   - SignalR hub state (flow.hubConnected)
     *   - whether telemetry events are actually flowing (flow.lastPacketMs)
     * @param {string} [overrideText] optional message that wins over the auto text
     */
    function renderConnectionUi(overrideText) {
        const now = Date.now();
        const gotAny = flow.lastPacketMs > 0;
        const ageMs  = gotAny ? now - flow.lastPacketMs : Infinity;
        const stale  = ageMs > STALE_AFTER_MS;

        let dotClass, text;
        if (!flow.hubConnected) {
            dotClass = "dot dot-off";
            text     = overrideText || "disconnected";
        } else if (!gotAny) {
            dotClass = "dot dot-wait";
            text     = "connected — waiting for telemetry";
        } else if (stale) {
            dotClass = "dot dot-wait";
            text     = `connected — no data for ${Math.round(ageMs / 1000)}s`;
        } else {
            dotClass = "dot dot-on";
            text     = overrideText || "receiving telemetry";
        }
        el.connDot.className = dotClass;
        el.connText.textContent = text;

        renderStaleBanner(gotAny, stale);
    }

    function renderStaleBanner(gotAny, stale) {
        if (!flow.hubConnected || (gotAny && !stale)) {
            el.staleBanner.classList.add("hidden");
            return;
        }
        el.staleBanner.classList.remove("hidden");

        const s = flow.lastStatus;
        if (!s) {
            el.staleHint.textContent = "Waiting for the first packet…";
            el.staleBanner.classList.remove("bad");
            return;
        }

        // Live UDP mode → give actionable troubleshooting hints based on what the
        // server is seeing on the wire.
        if (!s.useSimulator) {
            if ((s.rawPacketsReceived | 0) === 0) {
                el.staleBanner.classList.add("bad");
                el.staleHint.textContent =
                    `No UDP packets received on :${s.receivePort} from ${s.ps5Ip}. ` +
                    `Check that GT7 is running (in a car/replay), the PS5 IP is correct, ` +
                    `and inbound UDP :${s.receivePort} is allowed by the firewall.`;
            } else if ((s.decodedPackets | 0) === 0) {
                el.staleBanner.classList.add("bad");
                el.staleHint.textContent =
                    `${s.rawPacketsReceived} UDP packets received but none decoded ` +
                    `(${s.decodeFailures} failures). Last error: ${s.lastDecodeError || "unknown"}.`;
            } else {
                el.staleBanner.classList.remove("bad");
                const secs = s.msSinceLastPacket != null
                    ? (s.msSinceLastPacket / 1000).toFixed(1)
                    : "?";
                el.staleHint.textContent =
                    `Stream paused: last valid packet ${secs}s ago. ` +
                    `GT7 stops sending when the game is in a menu or paused.`;
            }
        } else {
            el.staleBanner.classList.remove("bad");
            el.staleHint.textContent = "Simulator has not produced a packet yet.";
        }
    }

    function renderDiagnostics() {
        const s = flow.lastStatus;
        if (!s) { el.diagText.textContent = "—"; return; }
        // Only show packet counters — mode/IP already have their own slots.
        const raw = s.rawPacketsReceived ?? 0;
        const dec = s.decodedPackets ?? 0;
        const fail = s.decodeFailures ?? 0;
        el.diagText.textContent = `rx ${raw} · dec ${dec} · err ${fail}`;
        el.diagText.classList.toggle("bad", !s.useSimulator && raw === 0);
        el.diagText.classList.toggle("warn", !s.useSimulator && raw > 0 && dec === 0);
    }

    async function start() {
        flow.hubConnected = false;
        renderConnectionUi("connecting…");
        await refreshStatus();
        try {
            await conn.start();
            flow.hubConnected = true;
            renderConnectionUi();
        } catch (e) {
            flow.hubConnected = false;
            renderConnectionUi("retrying…");
            setTimeout(start, 2000);
        }
    }
    start();
    // Refresh status + re-evaluate "stale" flag frequently so the header dot
    // and banner reflect reality even between packets.
    setInterval(() => { refreshStatus(); }, 2000);
    setInterval(() => { renderConnectionUi(); }, 500);

    // ----- Packet handler ---------------------------------------------------
    function onPacket(p) {
        if (!p) return;
        lastPacket = p;

        if (p.alertMaxRpm > 0) redlineRpm = p.alertMaxRpm;
        if (p.alertMinRpm > 0) shiftBeginRpm = p.alertMinRpm;

        // ---- Smoothed values ----
        smoothRpm   = lerp(smoothRpm,   p.engineRpm || 0, SMOOTH_ALPHA);
        const speedRaw = unit === "kmh" ? (p.speedKph || 0) : (p.speedMph || 0);
        smoothSpeed = lerp(smoothSpeed, speedRaw, SMOOTH_ALPHA);

        // ---- RPM arc ----
        const rpmPct = clamp(smoothRpm / (redlineRpm || 1), 0, 1);
        // pathLength is 1000; sweep half the arc
        setArc(el.rpmFill, rpmPct);
        el.rpm.textContent = Math.round(smoothRpm).toLocaleString();

        // ---- Shift lights ----
        updateShiftLights(smoothRpm, shiftBeginRpm, redlineRpm, (p.flags & FLAG_REV_LIMITER) !== 0);

        // ---- Gear + speed ----
        const gear = p.currentGear;
        const g = gear === 15 ? "N" : (gear === 0 ? "R" : (p.gearDisplay || String(gear ?? "")));
        el.gear.textContent = g;
        el.gear.classList.toggle("neutral", g === "N");
        el.gear.classList.toggle("rev",     g === "R");
        el.speed.textContent = Math.round(smoothSpeed);

        // ---- Pedals ----
        const thr = ((p.throttle ?? 0) / 255) * 100;
        const brk = ((p.brake    ?? 0) / 255) * 100;
        const clu = clamp((p.clutchPedal ?? 0), 0, 1) * 100;
        el.throttleBar.style.height = thr.toFixed(1) + "%";
        el.brakeBar.style.height    = brk.toFixed(1) + "%";
        el.clutchBar.style.height   = clu.toFixed(1) + "%";
        el.throttleVal.textContent = Math.round(thr) + "%";
        el.brakeVal.textContent    = Math.round(brk) + "%";
        el.clutchVal.textContent   = Math.round(clu) + "%";

        // ---- Session ----
        el.lap.textContent      = `${p.currentLap || 0} / ${p.totalLaps || 0}`;
        el.position.textContent = p.preRaceStartPos > 0
            ? `${p.preRaceStartPos} / ${p.numCarsPreRace}`
            : "—";
        el.lastLap.textContent  = formatLap(p.lastLapMs);
        el.bestLap.textContent  = formatLap(p.bestLapMs);

        // ---- Tires ----
        setTire(el.tireFL, p.tireTempFL);
        setTire(el.tireFR, p.tireTempFR);
        setTire(el.tireRL, p.tireTempRL);
        setTire(el.tireRR, p.tireTempRR);

        // ---- Car misc ----
        const fuelPct = clamp(p.fuelPercent ?? 0, 0, 100);
        el.fuelBar.style.width  = fuelPct + "%";
        el.fuelPct.textContent  = fuelPct.toFixed(1);

        // ---- Dials ----
        renderGauges(p);

        // ---- Flags ----
        const f = p.flags | 0;
        setFlag("onTrack",   f & FLAG_ON_TRACK);
        setFlag("paused",    f & FLAG_PAUSED);
        setFlag("turbo",     f & FLAG_TURBO);
        setFlag("revLimiter",f & FLAG_REV_LIMITER);
        setFlag("tcs",       f & FLAG_TCS);
        setFlag("asm",       f & FLAG_ASM);
        setFlag("lights",    f & FLAG_LIGHTS);
        setFlag("handbrake", f & FLAG_HANDBRAKE);
    }

    // ----- Helpers ----------------------------------------------------------
    function lerp(a, b, t) { return a + (b - a) * t; }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    // Round caps match the RPM pill. A zero-length dash paints a cap at each
    // end of the path — the same resting look as the reference shots.
    function setArc(node, pct) {
        node.setAttribute("stroke-dasharray", `${(pct * 1000).toFixed(1)} 1000`);
        node.setAttribute("stroke-linecap", "round");
    }

    // ----- Dials --------------------------------------------------------------
    function buildGauges() {
        el.gaugeGrid.innerHTML = "";
        for (const spec of GAUGE_SPECS) {
            const card = document.createElement("div");
            card.className = "mini-gauge";
            card.id = `gauge-${spec.key}`;
            card.innerHTML =
                `<label>${spec.label}</label>` +
                `<div class="g-face">` +
                    `<svg viewBox="0 0 140 90" preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
                        `<path d="${GAUGE_ARC}" fill="none" stroke="#141a24" stroke-width="12" stroke-linecap="round"/>` +
                        `<path class="g-fill" d="${GAUGE_ARC}" fill="none" stroke-width="12" stroke-linecap="round"` +
                        ` pathLength="1000" stroke-dasharray="0 1000"/>` +
                        `<g class="g-ticks" stroke="#6a7180" stroke-width="1.5">${tickMarkup(spec.tick)}</g>` +
                    `</svg>` +
                    `<div class="g-readout">` +
                        `<span class="g-value">--</span>` +
                        `<span class="g-unit">${spec.unit}</span>` +
                    `</div>` +
                `</div>`;
            el.gaugeGrid.appendChild(card);
            gauges[spec.key] = {
                spec,
                box: card,
                fill: card.querySelector(".g-fill"),
                value: card.querySelector(".g-value"),
                unit: card.querySelector(".g-unit"),
                smooth: 0,
            };
        }
    }

    // Marker at a fraction of the sweep (0 = left end, 1 = right end).
    function tickMarkup(frac) {
        if (frac === undefined) return "";
        const a = Math.PI * (1 - clamp(frac, 0, 1));
        const at = r => [70 + Math.cos(a) * r, 78 - Math.sin(a) * r];
        const [x1, y1] = at(50), [x2, y2] = at(58);
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}"` +
               ` x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }

    function renderGauges(p) {
        for (const key in gauges) {
            const g = gauges[key], spec = g.spec;
            if (spec.na && spec.na(p)) {
                g.smooth = 0;
                g.box.classList.add("na");
                g.box.classList.remove(...ZONE_CLASSES);
                setArc(g.fill, 0);
                g.value.textContent = "N/A";
                continue;
            }
            g.box.classList.remove("na");
            g.smooth = lerp(g.smooth, spec.read(p) || 0, spec.alpha ?? GAUGE_ALPHA);
            setGauge(g, g.smooth);
        }
    }

    function setGauge(g, v) {
        const spec = g.spec;
        const pct = clamp((v - spec.min) / (spec.max - spec.min), 0, 1);
        setArc(g.fill, pct);
        g.value.textContent = spec.format(v);
        // Some gauges (incline, cornering, slip) colour on a derived value, |v|.
        const zv = spec.zoneValue ? spec.zoneValue(v) : v;
        const cls = spec.zones.find(z => z.under === undefined || zv < z.under).cls;
        g.box.classList.remove(...ZONE_CLASSES);
        g.box.classList.add(cls);
    }

    // Road gradient from the velocity vector: how much of the motion is
    // vertical compared with the horizontal ground speed.
    function inclineDeg(p) {
        const horiz = Math.hypot(p.velocityX ?? 0, p.velocityZ ?? 0);
        if (!(horiz >= MIN_HORIZ_MPS)) return 0;
        return Math.atan2(p.velocityY ?? 0, horiz) * 180 / Math.PI;
    }

    // Cornering load: a car turning at yaw rate w while travelling at v pulls
    // roughly w * v / g lateral g. Sign follows the turn direction.
    function lateralG(p) {
        const speed = Math.abs(p.speedMps ?? 0);
        if (!(speed >= MIN_MOTION_MPS)) return 0;
        return clamp(((p.angularVelocityY ?? 0) * speed) / 9.80665, -5, 5);
    }

    // Wheel slip: how far the worst wheel's surface speed is from the ground
    // speed. Positive = spinning up, negative = locking under braking.
    function wheelSlipPct(p) {
        const ground = Math.abs(p.speedMps ?? 0);
        if (!(ground >= MIN_MOTION_MPS)) return 0;
        const wheels = [
            [p.wheelSpeedFL, p.tireRadiusFL],
            [p.wheelSpeedFR, p.tireRadiusFR],
            [p.wheelSpeedRL, p.tireRadiusRL],
            [p.wheelSpeedRR, p.tireRadiusRR],
        ];
        let worst = 0;
        for (const [omega, radius] of wheels) {
            if (!radius) continue; // no wheel data in this packet
            const surface = Math.abs((omega ?? 0) * radius);
            const dev = ((surface - ground) / ground) * 100;
            if (Math.abs(dev) > Math.abs(worst)) worst = dev;
        }
        return clamp(worst, -100, 100);
    }

    function updateShiftLights(rpm, from, to, revLimiter) {
        const range = Math.max(1, to - from);
        const pct = clamp((rpm - from) / range, 0, 1);
        const activeCount = Math.round(pct * SHIFT_LIGHT_COUNT);
        const lights = el.rpmLights.children;
        el.rpmLights.classList.toggle("flash", revLimiter);
        for (let i = 0; i < lights.length; i++) {
            const on = i < activeCount;
            lights[i].className = "light" + (on ? shiftClass(i) : "");
        }
    }
    function shiftClass(i) {
        // First third green, middle third yellow, last third red.
        if (i < SHIFT_LIGHT_COUNT / 3)          return " on-green";
        if (i < (2 * SHIFT_LIGHT_COUNT) / 3)    return " on-yellow";
        return " on-red";
    }

    function setTire(node, temp) {
        const t = temp ?? 0;
        node.querySelector(".temp").textContent = `${Math.round(toDisplayTemp(t))}°`;
        node.classList.remove("cold", "optimal", "warm", "hot");
        if (t < 60)       node.classList.add("cold");
        else if (t < 95)  node.classList.add("optimal");
        else if (t < 110) node.classList.add("warm");
        else              node.classList.add("hot");
    }

    function setFlag(name, on) {
        el.flags.forEach(node => {
            if (node.dataset.flag === name) node.classList.toggle("active", !!on);
        });
    }

    function formatLap(ms) {
        if (!ms || ms < 0 || ms > 3_600_000) return "--:--.---";
        const min = Math.floor(ms / 60000);
        const sec = Math.floor((ms % 60000) / 1000);
        const rest = ms % 1000;
        return `${min}:${String(sec).padStart(2,"0")}.${String(rest).padStart(3,"0")}`;
    }
})();
