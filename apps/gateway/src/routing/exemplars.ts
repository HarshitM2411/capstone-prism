/**
 * Reference prompts for the classifier's embedding half: a prompt is compared with the centre of
 * the simple ones and the centre of the complex ones (nearest centroid).
 *
 * These were written for this project, in the same spirit as the development set but with
 * different wording and topics. Neither the provided `routing_eval.jsonl` prompts nor their
 * labels appear here or anywhere else in routing logic (architecture §4.4, "no label leakage").
 */
export const SIMPLE_EXEMPLARS: readonly string[] = [
  'What is the capital of Japan?',
  'Convert 100 pounds to kilograms.',
  "Translate 'where is the library' into Italian.",
  "Define the word 'benevolent'.",
  'Who painted the Mona Lisa?',
  'What is 12 times 13?',
  'Rewrite this sentence so it is shorter: "We are currently in the process of reviewing your request."',
  "Extract the date from this text: 'The invoice was issued on March 3rd, 2026 and is due in 30 days.'",
  "Give me a synonym for 'big'.",
  'What does CPU stand for?',
  'List the planets in order from the sun.',
  'How many days are in a leap year?',
  "Fix the spelling mistakes in this sentence: 'I recieved the pakage yesterday.'",
  'Write a one-line greeting for a birthday card.',
  'What is the file extension for a Python script?',
  'Which color do you get by mixing blue and yellow?',
  'Here is a short list of names and phone numbers. What is the number for Dana?',
  'According to these meeting notes, what time does the review start?',
  'Is 64 a perfect square?',
  'Summarize this sentence in five words: "The quarterly report shows steady growth across all regions."',
];

export const COMPLEX_EXEMPLARS: readonly string[] = [
  'Prove that the harmonic series diverges.',
  'Derive the formula for the sum of a geometric series.',
  'Design a scalable architecture for a ride-sharing platform and justify your choices.',
  'Compare relational databases and document stores for an e-commerce catalog and recommend one.',
  'Explain why a distributed transaction across services is hard and describe the saga pattern with its trade-offs.',
  "Why might a service's tail latency spike under moderate load? List and explain the possible causes.",
  'Estimate the number of tennis balls that fit in a school bus, showing your reasoning.',
  'Write an efficient algorithm to detect a cycle in a directed graph and analyze its complexity.',
  'Create a detailed plan to roll out a new authentication system to ten million users, with a rollback at each stage.',
  'Analyze the trade-offs between consistency and availability in a globally replicated database.',
  'A web app gets slower every hour until it is restarted. What are the likely causes and how would you confirm each?',
  'Explain how public-key cryptography lets two strangers establish a shared secret, and discuss its weaknesses.',
  'Show that the square of an odd integer is one more than a multiple of eight.',
  'Optimize a slow SQL query that joins five large tables; describe your methodology and the trade-offs of each technique.',
  'Explain how garbage collection works in managed runtimes and the performance trade-offs of different collectors.',
  'Reason step by step about how many distinct arrangements the letters of a word with repeated letters have, and justify the formula.',
  'Propose a testing strategy for a payment system that must never double charge, covering failure injection.',
  'Discuss how you would architect a real-time collaborative editor and resolve conflicting edits.',
  'Evaluate the pros and cons of rewriting a legacy system versus refactoring it incrementally, and recommend an approach.',
  'Explain why quicksort is fast in practice despite its quadratic worst case, and how to mitigate bad inputs.',
];
