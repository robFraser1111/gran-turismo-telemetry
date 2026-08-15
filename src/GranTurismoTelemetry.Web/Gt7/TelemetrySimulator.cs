namespace GranTurismoTelemetry.Web.Gt7;

/// <summary>
/// Emits synthetic telemetry roughly resembling a lap: the car accelerates
/// through the gears, brakes for a corner, downshifts, and repeats. Handy for
/// UI development without a real PS5 on the network.
/// </summary>
public sealed class TelemetrySimulator
{
    public event Action<TelemetryPacket>? PacketReceived;

    public async Task RunAsync(CancellationToken ct)
    {
        var rng = new Random(42);
        int packetId = 0;
        int lap = 1;
        int bestLapMs = 0;
        int lastLapMs = 0;
        var lapStart = DateTime.UtcNow;
        const double lapSeconds = 60.0;

        // A very rough gearing curve (RPM redline ~8500).
        double[] gearMax = { 0, 60, 100, 140, 180, 220, 260, 300 };

        while (!ct.IsCancellationRequested)
        {
            var elapsedInLap = (DateTime.UtcNow - lapStart).TotalSeconds;
            if (elapsedInLap >= lapSeconds)
            {
                lastLapMs = (int)(elapsedInLap * 1000);
                bestLapMs = bestLapMs == 0 ? lastLapMs : Math.Min(bestLapMs, lastLapMs);
                lapStart = DateTime.UtcNow;
                elapsedInLap = 0;
                lap++;
            }

            // Piecewise "track" model in the [0..1] normalized position.
            double t = elapsedInLap / lapSeconds;
            double throttle, brake, targetSpeedKph;
            if (t < 0.35)      { throttle = 1.0; brake = 0.0; targetSpeedKph = 260; }
            else if (t < 0.45) { throttle = 0.0; brake = 0.9; targetSpeedKph = 90;  }
            else if (t < 0.65) { throttle = 0.75; brake = 0.0; targetSpeedKph = 180; }
            else if (t < 0.75) { throttle = 0.1; brake = 0.6; targetSpeedKph = 120; }
            else               { throttle = 1.0; brake = 0.0; targetSpeedKph = 280; }

            double speedKph = targetSpeedKph + Math.Sin(elapsedInLap * 4) * 4 + rng.NextDouble() * 2;
            double speedMps = speedKph / 3.6;

            // Choose the smallest gear whose max speed covers the current speed.
            int gear = 1;
            for (int g = 1; g < gearMax.Length; g++)
            {
                if (speedKph <= gearMax[g]) { gear = g; break; }
                gear = g;
            }
            double rpm = 1500 + (speedKph / gearMax[gear]) * 7000 + rng.NextDouble() * 100;
            rpm = Math.Clamp(rpm, 900, 8800);

            // Scripted off-track excursion once per lap so the dashboard's dirty-tire
            // heuristic (which watches the CarOnTrack bit) has something to react to
            // in simulator mode. During the window all four wheels get flagged; the
            // browser-side ~2 s cooldown then keeps them brown briefly after re-entry.
            bool onTrack = !(t >= 0.70 && t < 0.76);

            // Realistic-ish wheel telemetry: matching angular speeds against the
            // ground speed so the slip branch of the JS heuristic stays quiet on
            // clean laps. Radius ~0.33 m ≈ a typical road-car tire.
            const float tireRadius = 0.33f;
            float wheelRadS = (float)(speedMps / tireRadius);

            var pkt = new TelemetryPacket
            {
                PacketId   = packetId++,
                EngineRpm  = (float)rpm,
                SpeedMps   = (float)speedMps,
                Throttle   = (byte)Math.Clamp(throttle * 255, 0, 255),
                Brake      = (byte)Math.Clamp(brake * 255, 0, 255),
                CurrentGear = gear,
                SuggestedGear = 15,

                FuelCapacity = 100f,
                FuelLevel    = (float)Math.Max(5, 100 - packetId * 0.001),
                BoostKpa     = (float)(100 + throttle * 60 + rng.NextDouble() * 3),
                OilPressure  = 4.5f,
                WaterTemp    = 88f,
                OilTemp      = 108f,

                TireTempFL = (float)(80 + brake * 25 + rng.NextDouble() * 2),
                TireTempFR = (float)(80 + brake * 25 + rng.NextDouble() * 2),
                TireTempRL = (float)(85 + throttle * 15 + rng.NextDouble() * 2),
                TireTempRR = (float)(85 + throttle * 15 + rng.NextDouble() * 2),

                CurrentLap = lap,
                TotalLaps  = 5,
                BestLapMs  = bestLapMs,
                LastLapMs  = lastLapMs,

                AlertMinRpm = 6800,
                AlertMaxRpm = 8500,
                CalcMaxSpeedKph = 320,

                Flags = (onTrack ? SimulatorFlags.CarOnTrack : SimulatorFlags.None)
                        | SimulatorFlags.InGear
                        | SimulatorFlags.HasTurbo,

                WheelSpeedFL = wheelRadS,
                WheelSpeedFR = wheelRadS,
                WheelSpeedRL = wheelRadS,
                WheelSpeedRR = wheelRadS,

                TireRadiusFL = tireRadius,
                TireRadiusFR = tireRadius,
                TireRadiusRL = tireRadius,
                TireRadiusRR = tireRadius,

                GearRatios = new float[] { 3.5f, 2.4f, 1.8f, 1.4f, 1.1f, 0.9f, 0.7f, 0f },
            };

            PacketReceived?.Invoke(pkt);
            try { await Task.Delay(16, ct); } catch (OperationCanceledException) { break; }
        }
    }
}
