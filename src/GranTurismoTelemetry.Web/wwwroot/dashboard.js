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
        rpmFill: $("rpm-fill"), rpmLights: $("rpm-lights"),
        gear: $("gear"), rpm: $("rpm"),
        suggestedGear: $("suggested-gear"),
        suggestedGearVal: $("suggested-gear-val"),
        suggestedGearDir: $("suggested-gear-dir"),
        speed: $("speed"), speedUnit: $("speed-unit"),
        throttleBar: $("throttle-bar"), throttleVal: $("throttle-val"),
        brakeBar: $("brake-bar"), brakeVal: $("brake-val"),
        lap: $("lap"), position: $("position"),
        lastLap: $("last-lap"), bestLap: $("best-lap"),
        tireFL: $("tire-fl"), tireFR: $("tire-fr"),
        tireRL: $("tire-rl"), tireRR: $("tire-rr"),
        fuelBar: $("fuel-bar"), fuelPct: $("fuel-pct"),
        boost: $("boost"), oilTemp: $("oil-temp"), waterTemp: $("water-temp"),
        flags: document.querySelectorAll(".flag[data-flag]"),
    };

    // ----- State ------------------------------------------------------------
    let unit = localStorage.getItem("gt7.unit") || "kmh";
    setUnit(unit);
    buildShiftLights();

    let redlineRpm = 8500;
    let shiftBeginRpm = 6800; // fills the shift lights from this RPM upward

    // Simple exponential smoother for RPM/speed (keeps needle glassy).
    let smoothRpm = 0, smoothSpeed = 0;
    const SMOOTH_ALPHA = 0.35;

    // ----- Unit toggle ------------------------------------------------------
    el.unitKmh.addEventListener("click", () => setUnit("kmh"));
    el.unitMph.addEventListener("click", () => setUnit("mph"));
    function setUnit(u) {
        unit = u;
        localStorage.setItem("gt7.unit", u);
        el.unitKmh.classList.toggle("active", u === "kmh");
        el.unitMph.classList.toggle("active", u === "mph");
        el.speedUnit.textContent = u === "kmh" ? "km/h" : "mph";
    }

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

        if (p.alertMaxRpm > 0) redlineRpm = p.alertMaxRpm;
        if (p.alertMinRpm > 0) shiftBeginRpm = p.alertMinRpm;

        // ---- Smoothed values ----
        smoothRpm   = lerp(smoothRpm,   p.engineRpm || 0, SMOOTH_ALPHA);
        const speedRaw = unit === "kmh" ? (p.speedKph || 0) : (p.speedMph || 0);
        smoothSpeed = lerp(smoothSpeed, speedRaw, SMOOTH_ALPHA);

        // ---- RPM arc ----
        const rpmPct = clamp(smoothRpm / (redlineRpm || 1), 0, 1);
        // pathLength is 1000; sweep half the arc
        el.rpmFill.setAttribute("stroke-dasharray", `${(rpmPct * 1000).toFixed(1)} 1000`);
        el.rpm.textContent = Math.round(smoothRpm).toLocaleString();

        // ---- Shift lights ----
        updateShiftLights(smoothRpm, shiftBeginRpm, redlineRpm, (p.flags & FLAG_REV_LIMITER) !== 0);

        // ---- Gear + speed ----
        const g = p.gearDisplay || (p.currentGear === 0 ? "N" : (p.currentGear === 15 ? "R" : String(p.currentGear)));
        el.gear.textContent = g;
        el.gear.classList.toggle("neutral", g === "N");
        el.gear.classList.toggle("rev",     g === "R");
        el.speed.textContent = Math.round(smoothSpeed);
        updateSuggestedGear(p);

        // ---- Pedals ----
        const thr = ((p.throttle ?? 0) / 255) * 100;
        const brk = ((p.brake    ?? 0) / 255) * 100;
        el.throttleBar.style.width = thr.toFixed(1) + "%";
        el.brakeBar.style.width    = brk.toFixed(1) + "%";
        el.throttleVal.textContent = Math.round(thr) + "%";
        el.brakeVal.textContent    = Math.round(brk) + "%";

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
        el.boost.innerHTML      = `${(p.boostBar ?? 0).toFixed(2)} <em>bar</em>`;
        el.oilTemp.innerHTML    = `${Math.round(p.oilTemp   ?? 0)} <em>°C</em>`;
        el.waterTemp.innerHTML  = `${Math.round(p.waterTemp ?? 0)} <em>°C</em>`;

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

    function updateSuggestedGear(p) {
        if (!el.suggestedGear) return;
        const current = p.currentGear ?? 0;
        const suggested = p.suggestedGear ?? 15;
        const has = p.hasSuggestedGear === true
            || (suggested > 0 && suggested < 15 && suggested !== current);
        el.suggestedGear.classList.toggle("hidden", !has);
        el.suggestedGear.classList.toggle("up", has && suggested > current);
        el.suggestedGear.classList.toggle("down", has && suggested < current);
        if (!has) return;
        el.suggestedGearVal.textContent = p.suggestedGearDisplay || (suggested === 0 ? "N" : String(suggested));
        el.suggestedGearDir.textContent = suggested > current ? "▲" : "▼";
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
        node.querySelector(".temp").textContent = `${Math.round(t)}°`;
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
