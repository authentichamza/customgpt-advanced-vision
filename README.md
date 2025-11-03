## Schematic Vision POC

Prototype Next.js app that sends user questions and high-resolution building schematics directly to OpenAI's multimodal models. The goal is to validate whether complex spatial queries (navigation, fixture counts, accessibility checks) can be answered reliably from a single plan image or a small set of tiled exports.

---

### 1. Prerequisites
- Node.js 18+ (v22 tested) and npm.
- OpenAI API key with access to the `gpt-4.1` family (or another multimodal-capable model).
- High-resolution schematic export saved as PNG (manual conversion from the source PDF to preserve fidelity).
- This project uses plain JavaScript + JSX (no TypeScript) to keep the prototype lightweight.

---

### 2. Prepare schematic exports
1. Export the provided PDF manually at the highest practical resolution (e.g. 600–1200 dpi) and save the PNGs locally.
2. When testing the app, upload the PNGs through the UI (they are kept in-memory for that session and sent directly to the model).
3. (Optional) If you want persistent reference imagery, add entries to `images` in `src/config/schematic.js`. Leaving it empty (default) makes the system rely entirely on user uploads.

> Tip: keep filenames descriptive (e.g. `floorplan_core.png`, `floorplan_west.png`) and ensure consistent orientation so directions remain reliable.

---

### 3. Configure environment variables
Duplicate `.env.example` and rename to `.env.local`, then fill in your API key.

```bash
cp .env.example .env.local
```

Optional overrides:
- `OPENAI_VISION_MODEL`: defaults to `gpt-4.1`, but you can switch to `gpt-4o` or `gpt-4.1-mini` if latency/cost is a concern.
- `NEXT_PUBLIC_OPENAI_VISION_MODEL`: optional mirror so the current selection is shown in the UI header.

---

### 4. Install dependencies & run locally

```bash
npm install
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) and submit queries straight from the UI. The server converts the schematic PNG(s) to base64 data URLs and attaches them to each OpenAI Responses API call alongside the user's question.

#### Optional uploads
- Use the "Additional images" widget on the left panel to add up to 6 supplemental PNG/JPEG/TIFF exports (<=12 MB each). Files stay in-session, never touch disk, and travel with the prompt as inline base64 data URLs.
- Remove an upload from the list to exclude it from future requests.

---

### 5. How it works
- `src/config/schematic.js` houses the session defaults (display name, optional static images, example questions, model settings).
- `src/app/api/analyze/route.js` handles POST requests, loads any static images from disk, merges session uploads provided by the client, and issues a `responses.create` call to the configured vision model.
  - Uploads larger than ~6 MB are streamed to S3 using credentials from `.env`, and the model receives a short-lived signed URL instead of an inline base64 payload. Smaller images stay inline for speed.
- The front end (`src/app/page.jsx`) provides:
  - Prompt input and curated examples.
  - Session-scoped upload widget plus preview grid for everything headed to the model.
  - Response viewer with token usage and USD estimates derived from the configured pricing metadata.
  - Post-response telemetry displays whether each upload was inlined or offloaded to S3.

Because the schematic is attached to every request, no pre-computed summaries are required and the model always reasons over the raw imagery.

---

### 6. Model choice
- **Default model**: `gpt-4.1` (best reasoning quality today).
- Alternatives to experiment with:
  1. `gpt-4o`: faster latency with slightly lower spatial reasoning depth.
  2. `gpt-4.1-mini`: lightweight exploratory option ideal for quick UX validation.

Token usage per response is surfaced in the UI; consult OpenAI's pricing page for the latest cost information.

**Handling large schematics with S3**

Set `AWS_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, and `AWS_ACCESS_KEY_SECRET` (optionally `AWS_REGION` / `AWS_VISION_PREFIX`) in your environment to enable automatic offloading. When enabled, the API route uploads large session images to your bucket and sends a 1-hour presigned URL to OpenAI, avoiding `413 Request Entity Too Large` errors while keeping uploads private.

---

### 7. Swapping schematics
1. Drop the new PNG(s) into `public/schematics/`.
2. Update `src/config/schematic.js`:
   - Change the `displayName` if needed.
   - Adjust the `images` array to reference new files and captions.
   - Optionally refresh the example questions to mirror the new floorplan.
3. Restart the dev server to ensure Next.js picks up the new static assets.

No UI code changes are required unless the new plan demands a different layout or additional metadata.

---

### 8. Production considerations
- For >25 MB imagery, consider slicing into overlapping tiles to stay within upload limits while boosting OCR precision.
- Add request caching if the same questions repeat (e.g. pre-populated "Stair to Elevator" directions per floor).
- Consider adding structured response formats (JSON) before integrating with downstream systems.
- Verify privacy requirements: the current approach transmits raw schematics to OpenAI each time; if sensitive, explore Enterprise controls or on-prem alternatives.

---

### 9. Next steps (suggested)
1. Validate the four sample questions end-to-end to confirm the model reads the schematic accurately.
2. Stress-test with at least 10 novel queries (accessibility audits, evacuation routes, rare symbols).
3. Capture failure cases + transcripts to inform prompt tuning or tiling strategy.
4. Once accuracy is acceptable, wire the API endpoint into the broader doc analyst flow.
