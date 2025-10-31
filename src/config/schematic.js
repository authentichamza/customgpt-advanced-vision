export const schematicConfig = {
  displayName: "Custom Schematic Session",
  systemPrompt: [
    "You are an expert facilities wayfinding and compliance assistant.",
    "Use every schematic image provided in this conversation to answer the user question.",
    "Always reason over the visual evidence before stating an answer.",
    "When giving turn-by-turn directions, call out landmarks, path segments, and transitions clearly.",
    "If details are ambiguous or unreadable, explain the uncertainty instead of guessing.",
  ].join(" "),
  images: [
    // Provide static reference schematics here if you want them attached automatically.
    // Leaving this array empty makes the system rely entirely on session uploads.
  ],
  model: {
    name: "gpt-4.1",
    maxOutputTokens: 1024,
  },
  exampleQuestions: [
    "How do I get from Stair 6 to Elevator 3? Provide clear step-by-step directions.",
    "How many restrooms include at least two lavatories, and where are they located?",
    "Identify every accessibility ramp you can find and describe their nearby landmarks.",
    "Compare the terraces and tell me which one is the largest with supporting reasoning.",
  ],
};
