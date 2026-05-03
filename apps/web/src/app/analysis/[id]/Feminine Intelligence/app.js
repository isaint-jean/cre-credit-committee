(function () {
  "use strict";

  /* =============================================
     FEMININE INTELLIGENCE — Application
     Router, Quiz Engine, Renderers, All Content
     ============================================= */

  // =============================================
  // CATEGORIES
  // =============================================
  const CATEGORIES = {
    hair: {
      name: "Hair Intelligence",
      icon: "✦",
      desc: "Clarifying, styling, scent, and routine — everything your hair has been asking for.",
      modules: ["hair-clean-slate", "hair-no-heat", "hair-scent", "hair-code"],
    },
    skin: {
      name: "Skin Intelligence",
      icon: "✦",
      desc: "Softness, awareness, and timing — the rituals that change how your skin feels all day.",
      modules: ["skin-soft", "skin-shower", "skin-timing"],
    },
    "feminine-care": {
      name: "Body Intelligence",
      icon: "✦",
      desc: "Gut health, digestion, and clean eating — the things no one taught you but every polished woman knows.",
      modules: ["care-flat-stomach", "care-quiet-system", "care-eating"],
    },
    "beauty-layer": {
      name: "Beauty Layer",
      icon: "✦",
      desc: "Less makeup, more intention — the art of looking polished without performing.",
      modules: [
        "beauty-less-makeup",
        "beauty-day-night",
        "beauty-clean-canvas",
      ],
    },
  };

  // =============================================
  // ENTRY QUIZ
  // =============================================
  const ENTRY_QUIZ = {
    title: "Where Does Your Feminine Intelligence Begin?",
    subtitle:
      "8 questions. 3 minutes. No wrong answers. Find your starting point.",
    questions: [
      {
        q: "When you look in the mirror in the morning, what bothers you first?",
        opts: [
          "My hair feels dull, undefined, or lifeless",
          "My skin looks tired, uneven, or dry",
          "My stomach feels bloated or heavy before the day even starts",
          "I look unpolished \u2014 like I don\u2019t know how to \u201cfinish\u201d my look",
        ],
      },
      {
        q: "Which of these feels most like a secret frustration you don\u2019t talk about?",
        opts: [
          "My hair never smells or feels as fresh as I want it to",
          "I don\u2019t really have a skincare routine \u2014 I just wash and hope",
          "My digestion, bloating, or bathroom habits feel off and I don\u2019t know who to ask",
          "I own makeup but I don\u2019t know what actually suits me",
        ],
      },
      {
        q: "If your best friend described you honestly, she\u2019d say:",
        opts: [
          "\u201cShe\u2019s beautiful but her hair is holding her back\u201d",
          "\u201cShe\u2019d glow if she just took care of her skin consistently\u201d",
          "\u201cShe doesn\u2019t realize how much her gut is affecting everything\u201d",
          "\u201cShe could look so put-together with just a few tweaks\u201d",
        ],
      },
      {
        q: "What do you find yourself Googling late at night?",
        opts: [
          "How to make my hair grow, look healthier, or hold a style",
          "Why my skin looks like this and what products actually work",
          "Why I\u2019m always bloated, tired, or inflamed",
          "Easy makeup looks, grooming tips, or \u201chow to look polished\u201d",
        ],
      },
      {
        q: "Which of these would change how you feel the most?",
        opts: [
          "Walking out the door with hair that looks and smells incredible",
          "Touching my skin and it actually feeling soft \u2014 all day",
          "Waking up with a flat stomach and good energy",
          "Looking effortlessly put-together without spending an hour getting ready",
        ],
      },
      {
        q: "When you think about \u201cthat girl\u201d \u2014 the one who has it together \u2014 what does she know that you don\u2019t?",
        opts: [
          "How to take care of her hair properly \u2014 wash, style, maintain",
          "A skincare routine that actually works and sticks",
          "How to eat and live in a way that keeps her body feeling light",
          "How to look polished and clean with minimal effort",
        ],
      },
      {
        q: "Which habit do you wish someone had taught you younger?",
        opts: [
          "How to build a real hair routine \u2014 clarifying, styling, protecting",
          "How to moisturize properly and when to do it",
          "What to eat, how digestion works, and why it matters for everything",
          "How to do natural makeup and present myself with quiet confidence",
        ],
      },
      {
        q: "Be honest \u2014 which area feels the most neglected right now?",
        opts: [
          "My hair \u2014 I know it could be so much better",
          "My skin \u2014 I\u2019m inconsistent and unsure what I\u2019m doing",
          "My body from the inside \u2014 gut, digestion, inflammation",
          "My grooming \u2014 I don\u2019t have a \u201clook\u201d or finishing routine",
        ],
      },
    ],
    // A=hair, B=skin, C=feminine-care, D=beauty-layer
    map: ["hair", "skin", "feminine-care", "beauty-layer"],
    tiebreaker: 7, // Q8 index
    tiebreaker2: 4, // Q5 index
    results: {
      hair: {
        name: "The Hair Awakening",
        line: "Your hair has been whispering for attention. It\u2019s time to finally listen.",
        body: "Your hair is the thing standing between you and the version of yourself you see in your head. You\u2019ve tried products. You\u2019ve watched tutorials. But nothing has stuck because no one gave you a system \u2014 just scattered tips.",
        cta: "Start Your Hair Intelligence Path",
        path: "#/category/hair",
      },
      skin: {
        name: "The Skin Reset",
        line: "Your skin has been asking for consistency. Not more products \u2014 more intention.",
        body: "You\u2019ve bought products. You\u2019ve started routines. But nothing lasts past two weeks because the routine didn\u2019t fit your life or your skin. You don\u2019t need more options. You need the right method at the right time.",
        cta: "Start Your Skin Intelligence Path",
        path: "#/category/skin",
      },
      "feminine-care": {
        name: "The Inner Reset",
        line: "Everything you see on the outside starts with what\u2019s happening inside. You already knew that.",
        body: "You feel it \u2014 the bloating, the heaviness, the cycle that doesn\u2019t make sense. You\u2019ve Googled it a hundred times but nothing speaks to you like a woman explaining it to another woman. No clinical language. No diet culture. Just real, quiet intelligence.",
        cta: "Start Your Body Intelligence Path",
        path: "#/category/feminine-care",
      },
      "beauty-layer": {
        name: "The Beauty Architect",
        line: "You don\u2019t need more makeup. You need a system that makes the most of what you already have.",
        body: "You own products. You\u2019ve watched the tutorials. But when you look in the mirror, something still feels unfinished. The problem isn\u2019t skill \u2014 it\u2019s that no one taught you your face. Your features. Your version of \u201cpolished.\u201d",
        cta: "Start Your Beauty Layer Path",
        path: "#/category/beauty-layer",
      },
    },
  };

  // =============================================
  // MODULES — All 13
  // =============================================
  const MODULES = {
    // -------------------------------------------
    // HAIR 1: The Clean Slate
    // -------------------------------------------
    "hair-clean-slate": {
      category: "hair",
      title: "The Clean Slate",
      subtitle: "Your hair is tired. Let\u2019s wake it up.",
      intro:
        "Before you can build a routine, you need a reset. Buildup, residue, and product weight are the silent reasons your hair feels heavy, looks dull, and won\u2019t hold a style.",
      cards: [
        [
          "What Buildup Actually Is",
          "Silicones, oils, hard water minerals, and dry shampoo layers coat your hair over time. Your hair isn\u2019t damaged \u2014 it\u2019s suffocating.",
        ],
        [
          "The Aloe Vera Method",
          "Mix pure aloe vera gel with a tablespoon of apple cider vinegar. Apply to damp hair, leave 10 minutes, rinse. Your hair will feel like it took its first real breath.",
        ],
        [
          "Signs Your Scalp Is Suffocating",
          "Itching, flaking, hair that gets greasy within hours of washing \u2014 these aren\u2019t about your hair type. They\u2019re about what\u2019s sitting on your scalp.",
        ],
        [
          "How Often to Clarify",
          "Fine hair: every 2 weeks. Thick or coily hair: once a month. If you use heavy products daily, bump it up. Your hair will tell you when it\u2019s ready.",
        ],
        [
          "After the Reset",
          "Immediately after clarifying, your hair is at its most absorbent. This is when deep conditioning actually works. Don\u2019t skip this step.",
        ],
      ],
      quiz: {
        title: "How Congested Is Your Hair?",
        subtitle: "6 questions. Let\u2019s find out what your hair is carrying.",
        questions: [
          {
            q: "How does your hair feel the day after washing it?",
            opts: [
              "Clean and light \u2014 it feels fresh",
              "Okay, but it loses volume quickly",
              "Already a bit greasy or flat",
              "Heavy, coated, like the wash didn\u2019t fully work",
            ],
          },
          {
            q: "How many styling products do you use on a typical day?",
            opts: [
              "0\u20131 \u2014 I keep it minimal",
              "2\u20133 \u2014 a few staples",
              "4+ \u2014 I layer several products",
              "I\u2019ve lost count honestly",
            ],
          },
          {
            q: "When was the last time you did a clarifying wash?",
            opts: [
              "Within the last 2 weeks",
              "A month or two ago",
              "I\u2019m not sure what that is",
              "I\u2019ve never done one",
            ],
          },
          {
            q: "How does your scalp feel most days?",
            opts: [
              "Clean and balanced",
              "Slightly oily by the end of the day",
              "Itchy or flaky sometimes",
              "Irritated, tight, or constantly oily",
            ],
          },
          {
            q: "When you apply a hair mask or conditioner, does your hair absorb it?",
            opts: [
              "Yes \u2014 it drinks it up",
              "Somewhat \u2014 but it takes a while",
              "Not really \u2014 it just sits on top",
              "No \u2014 my hair repels product",
            ],
          },
          {
            q: "How would you describe your hair\u2019s current state?",
            opts: [
              "Healthy and manageable",
              "Fine but could be better \u2014 missing something",
              "Dull, heavy, or weighed down",
              "Frustrated \u2014 nothing I do seems to help",
            ],
          },
        ],
        map: [
          "The Fresh Start",
          "The Slow Suffocator",
          "The Product Hoarder",
          "The Scalp Screamer",
        ],
        results: {
          "The Fresh Start": {
            line: "Your hair is relatively clean. You just need a maintenance rhythm.",
            shift: [
              "You don\u2019t need a heavy reset \u2014 just a consistent clarifying schedule",
            ],
            start: [
              "Clarify once a month to maintain your baseline",
              "Follow every clarifying wash with a deep conditioner",
              "Avoid heavy silicone-based products that rebuild residue",
            ],
          },
          "The Slow Suffocator": {
            line: "Buildup is creeping in. Your hair is losing shine gradually and you can\u2019t figure out why.",
            shift: [
              "The dullness you\u2019re noticing isn\u2019t damage \u2014 it\u2019s layers of product your hair can\u2019t breathe through",
            ],
            start: [
              "Do a full clarifying wash this week using the aloe vera method",
              "Switch to one lighter styling product for 2 weeks and observe the difference",
              "Clarify every 2\u20133 weeks going forward",
            ],
          },
          "The Product Hoarder": {
            line: "Your hair is buried under layers of product. It\u2019s not absorbing anything anymore.",
            shift: [
              "More product is not better \u2014 your hair has been screaming for less",
            ],
            start: [
              "Full clarifying reset: aloe vera + ACV wash, leave 15 minutes",
              "Strip your routine to 3 products max for the next month",
              "Deep condition immediately after clarifying \u2014 your hair will finally absorb it",
              "Clarify every 2 weeks until your hair responds to products again",
            ],
          },
          "The Scalp Screamer": {
            line: "Your scalp is irritated, congested, and overloaded. This is a full reset moment.",
            shift: [
              "The itching, flaking, and greasiness are your scalp\u2019s distress signals \u2014 not your hair type",
            ],
            start: [
              "Gentle clarifying wash focused on the scalp \u2014 massage with fingertips, not nails",
              "Remove all heavy oils, butters, and dry shampoo from your routine for 2 weeks",
              "Use a lightweight, fragrance-free conditioner on ends only",
              "If irritation persists after 2 clarifying cycles, consider a scalp-specific treatment",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // HAIR 2: The No-Heat Signature
    // -------------------------------------------
    "hair-no-heat": {
      category: "hair",
      title: "The No-Heat Signature",
      subtitle: "Beautiful hair that never touched a hot tool.",
      intro:
        "Heat damage is the silent killer of feminine hair. But giving up heat doesn\u2019t mean giving up style. It means learning a smarter, softer way to shape your look.",
      cards: [
        [
          "Why Heat Damage Is Silent",
          "You won\u2019t see it until it\u2019s too late. Heat weakens the protein bonds in your hair strand by strand. By the time your ends feel crispy, the damage is years deep.",
        ],
        [
          "Flexi Rods: The Overnight Cheat Code",
          "Wrap damp hair around flexi rods before bed. Wake up with bouncy, defined curls that last 3+ days. No heat. No damage. Just patience.",
        ],
        [
          "Bonnet Culture",
          "A silk or satin bonnet isn\u2019t just for sleeping \u2014 it\u2019s for preserving. Every heatless style lasts longer when you protect it overnight.",
        ],
        [
          "Air Drying with Intention",
          "Don\u2019t just let your hair dry \u2014 shape it while it dries. Twist, braid, or pin it into the style you want. Your hair sets as it dries. Use that.",
        ],
        [
          "Making It Last",
          "The secret to a 3-day heatless style: dry shampoo at the roots on day 2, a light refresh mist on day 3, and a bonnet every night. Consistency, not repetition.",
        ],
      ],
      quiz: {
        title: "What\u2019s Your Heatless Style Identity?",
        subtitle:
          "6 questions. Find the no-heat method that matches your texture and lifestyle.",
        questions: [
          {
            q: "How often do you currently use heat on your hair?",
            opts: [
              "Almost never \u2014 I avoid it",
              "Once a week or so",
              "Several times a week",
              "Almost every time I style",
            ],
          },
          {
            q: "What\u2019s your natural hair texture?",
            opts: [
              "Straight or slightly wavy",
              "Wavy with some curl",
              "Curly or coily",
              "I honestly don\u2019t know \u2014 I always heat-style it",
            ],
          },
          {
            q: "How much time can you give your hair in the evening?",
            opts: [
              "10 minutes max \u2014 I need quick methods",
              "20\u201330 minutes \u2014 I can commit to a routine",
              "I have time \u2014 I\u2019m willing to invest in the process",
              "None \u2014 I need wash-and-go options",
            ],
          },
          {
            q: "What kind of result do you want when you wake up?",
            opts: [
              "Smooth and sleek \u2014 polished, straight-looking",
              "Soft, loose waves \u2014 effortless and romantic",
              "Defined curls \u2014 bouncy and voluminous",
              "Textured definition \u2014 natural pattern, amplified",
            ],
          },
          {
            q: "How long do you need a style to last?",
            opts: [
              "Just one day is fine",
              "2\u20133 days would be ideal",
              "I want a full week if possible",
              "I restyle every day anyway",
            ],
          },
          {
            q: "What\u2019s your biggest frustration with your hair right now?",
            opts: [
              "It won\u2019t hold a style without heat",
              "It\u2019s frizzy or undefined when I skip heat tools",
              "I don\u2019t know any heatless techniques",
              "I\u2019m tired of damaging it but I don\u2019t know the alternative",
            ],
          },
        ],
        map: [
          "The Sleek Minimalist",
          "The Soft Wave Girl",
          "The Bouncy Curl",
          "The Twist-Out Queen",
        ],
        results: {
          "The Sleek Minimalist": {
            line: "You want smooth, polished hair without the flat iron. It\u2019s absolutely possible.",
            shift: [
              "Sleekness without heat is about tension and drying method \u2014 not temperature",
            ],
            start: [
              "Wrap damp hair tightly around your head with bobby pins (the \u201cwrap method\u201d) and tie with a silk scarf overnight",
              "Apply a light smoothing serum to damp hair before wrapping",
              "Use a microfiber towel to reduce frizz while drying",
            ],
          },
          "The Soft Wave Girl": {
            line: "Effortless, romantic waves that look like you woke up beautiful. Because you did.",
            shift: [
              "Waves are the easiest heatless style \u2014 your hair naturally wants to do this",
            ],
            start: [
              "Braid damp hair into 2\u20133 loose braids before bed",
              "For tighter waves, use more braids. For looser waves, use fewer",
              "Finish with a light texturizing mist and scrunch gently in the morning",
            ],
          },
          "The Bouncy Curl": {
            line: "Volume, bounce, and definition \u2014 curls that move when you move.",
            shift: [
              "Flexi rods and perm rods are your new best friends \u2014 they create heat-quality curls overnight",
            ],
            start: [
              "Section damp hair and wrap around flexi rods, rolling from ends to roots",
              "Sleep with a satin bonnet to hold the rods in place",
              "In the morning, unravel gently, shake at the roots, and don\u2019t touch for 10 minutes \u2014 the curls will set as they cool",
            ],
          },
          "The Twist-Out Queen": {
            line: "Your natural texture is your signature. Let\u2019s amplify it.",
            shift: [
              "You don\u2019t need to reshape your hair \u2014 you need to define the pattern it already has",
            ],
            start: [
              "Two-strand twist on damp, conditioned hair \u2014 let it dry completely before unraveling",
              "Use a curl-defining cream or leave-in conditioner before twisting",
              "Unravel in the morning, separate gently with fingers, and fluff at the roots for volume",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // HAIR 3: Scent Is a Language
    // -------------------------------------------
    "hair-scent": {
      category: "hair",
      title: "Scent Is a Language",
      subtitle: "Learn to speak it through your hair.",
      intro:
        "There\u2019s a version of you that leaves a trace in every room she walks through. Not loud. Not obvious. Just \u2014 unmistakable. This module teaches you how to make your hair the quietest, most powerful part of your presence.",
      cards: [
        [
          "The Invisible Signature",
          "Your hair holds scent longer than your skin. Polished women know where to layer it.",
        ],
        [
          "Clean \u2260 Memorable",
          "Smelling clean is baseline. Smelling intentional is presence.",
        ],
        [
          "The Layering Secret",
          "Body wash. Lotion. Hair mist. Perfume. Your hair is the final layer \u2014 the one that lingers.",
        ],
        [
          "Where You Spray Matters",
          "Never spray perfume directly on dry hair. Use a hair mist on damp ends and mid-lengths.",
        ],
        [
          "Your Scent Trail",
          "It\u2019s not about being strong. It\u2019s about being remembered.",
        ],
      ],
      quiz: {
        title: "What Kind of Scent Presence Do You Have?",
        subtitle:
          "6 questions. 2 minutes. Discover how the world experiences you.",
        questions: [
          {
            q: "When you walk into a room, what do people notice first?",
            opts: [
              "My energy \u2014 I\u2019m warm and people gravitate toward me",
              "Honestly\u2026 probably nothing specific",
              "My look \u2014 I put effort into being polished",
              "My vibe \u2014 something mysterious, they can\u2019t quite name it",
            ],
          },
          {
            q: "How do you currently use fragrance?",
            opts: [
              "I spray perfume on my wrists and neck, classic style",
              "I don\u2019t really have a fragrance routine",
              "I layer \u2014 lotion, perfume, sometimes a body mist",
              "I have a signature scent I never go without",
            ],
          },
          {
            q: "When someone hugs you, what do they smell?",
            opts: [
              "Something soft \u2014 lotion or body wash, probably",
              "I honestly don\u2019t know",
              "My perfume, for sure",
              "Something specific to me \u2014 people have commented on it before",
            ],
          },
          {
            q: "How do you feel about your hair\u2019s scent right now?",
            opts: [
              "It smells fine \u2014 like shampoo, mostly",
              "I\u2019ve never really thought about it",
              "I wish it smelled better or lasted longer",
              "I\u2019ve already started working on this \u2014 I want to refine it",
            ],
          },
          {
            q: "What feeling do you want your presence to leave behind?",
            opts: [
              "Warmth \u2014 like someone safe and inviting",
              "I just want to feel put-together",
              "Elegance \u2014 like someone who has her life handled",
              "Intrigue \u2014 like someone worth knowing",
            ],
          },
          {
            q: "Pick the word that feels most like the woman you\u2019re becoming:",
            opts: ["Soft", "Aware", "Refined", "Magnetic"],
          },
        ],
        map: [
          "The Velvet Aura",
          "The Blank Canvas",
          "The Polished Note",
          "The Quiet Storm",
        ],
        results: {
          "The Velvet Aura": {
            line: "You already carry warmth. People feel comfortable around you before you speak. Your scent presence is soft \u2014 but it\u2019s not yet intentional.",
            shift: [
              "Stop relying on leftover shampoo scent as your only layer",
              "Your warmth is your power \u2014 build a scent routine that amplifies it",
            ],
            start: [
              "Layer a vanilla or warm-musk hair mist on damp hair after washing",
              "Apply to mid-lengths before leaving the house",
              "Try a dedicated hair perfume to separate your hair scent from your skin scent",
            ],
          },
          "The Blank Canvas": {
            line: "You\u2019re not behind \u2014 you\u2019re at the beginning. And that\u2019s actually the most exciting place to be.",
            shift: [
              "Stop treating scent as optional \u2014 it\u2019s part of your presence",
              "Start noticing what scents you\u2019re drawn to in everyday life",
            ],
            start: [
              "Begin with one product: a light hair perfume you wear daily for 2 weeks",
              "This builds association \u2014 people will start connecting that scent to you",
              "Choose something clean and simple \u2014 fresh linen, light citrus, or soft floral",
            ],
          },
          "The Polished Note": {
            line: "You already invest in how you present yourself. The missing piece? Your scent layers aren\u2019t speaking to each other yet.",
            shift: [
              "Audit your current fragrance routine \u2014 are your lotion, perfume, and hair scent complementary or competing?",
            ],
            start: [
              "Match your hair scent to your fragrance family \u2014 not the same product, the same feeling",
              "Apply hair perfume as the final step of styling \u2014 the finishing signature",
              "Focus on the trail: scent should linger after you, not announce you before",
            ],
          },
          "The Quiet Storm": {
            line: "You already understand presence. Your scent game is advanced \u2014 now it\u2019s time to make it unforgettable.",
            shift: [
              "You don\u2019t need more products \u2014 you need precision",
            ],
            start: [
              "Apply hair perfume only to the ends \u2014 movement activates it throughout the day",
              "Build scent rituals around moments: a morning mist, a pre-evening refresh",
              "Own your signature so deeply that people recognize you by scent before sight",
            ],
          },
        },
        showMapaon: true,
      },
    },

    // -------------------------------------------
    // HAIR 4: The Hair Code
    // -------------------------------------------
    "hair-code": {
      category: "hair",
      title: "The Hair Code",
      subtitle: "The foundational routine every woman should have.",
      intro:
        "You don\u2019t need 15 products. You need 4 steps in the right order, done consistently. This is the system your hair has been waiting for.",
      cards: [
        [
          "The 4-Step Foundation",
          "Cleanse. Condition. Protect. Style. Every hair routine in the world is a variation of these four steps. Master them and everything else is refinement.",
        ],
        [
          "How to Actually Wash",
          "Shampoo the scalp, not the ends. Massage with fingertips in small circles for 60 seconds. Most women rush this step and wonder why their hair doesn\u2019t feel clean.",
        ],
        [
          "Conditioner Placement Matters",
          "Mid-lengths to ends only. Never on your scalp. Leave it for 2\u20133 minutes minimum. This isn\u2019t a suggestion \u2014 it\u2019s where the softness actually comes from.",
        ],
        [
          "Your Personal Cadence",
          "Fine hair may need washing every 2 days. Coily hair may thrive on once a week. Stop following someone else\u2019s schedule. Build your own.",
        ],
        [
          "The Hair Diary",
          "For 3 weeks, note what you used, what you did, and how your hair looked the next day. Patterns will emerge. Your hair is already telling you what works \u2014 you just need to listen.",
        ],
      ],
      quiz: {
        title: "What Level Is Your Hair Routine?",
        subtitle: "6 questions. Find out where you stand \u2014 and what\u2019s missing.",
        questions: [
          {
            q: "Do you currently have a consistent hair wash routine?",
            opts: [
              "No \u2014 I wash when it feels dirty",
              "Sort of \u2014 I try but it\u2019s inconsistent",
              "Yes \u2014 I wash on a schedule",
              "Yes \u2014 and I\u2019ve tailored it to my hair type",
            ],
          },
          {
            q: "Where do you apply conditioner?",
            opts: [
              "All over \u2014 scalp to ends",
              "I\u2019m not sure \u2014 wherever it lands",
              "Mid-lengths to ends",
              "Mid-lengths to ends, and I leave it in for a few minutes",
            ],
          },
          {
            q: "How do you dry your hair?",
            opts: [
              "Rough towel dry",
              "Regular towel, gently",
              "Microfiber towel or t-shirt",
              "Microfiber towel plus a specific method for my texture",
            ],
          },
          {
            q: "Do you use any form of heat protection?",
            opts: [
              "What\u2019s heat protection?",
              "I should but I forget",
              "Yes, when I use heat tools",
              "I use heat protection or I\u2019ve eliminated heat entirely",
            ],
          },
          {
            q: "How many hair products are in your rotation right now?",
            opts: [
              "Just shampoo \u2014 maybe conditioner sometimes",
              "A few \u2014 but I don\u2019t know what each one is really for",
              "A curated set \u2014 I know what each product does",
              "A full system \u2014 cleanse, condition, treat, style, protect",
            ],
          },
          {
            q: "Have you ever tracked what works for your hair?",
            opts: [
              "No \u2014 I just try things randomly",
              "I remember what I liked but I don\u2019t write it down",
              "I have mental notes about what works",
              "Yes \u2014 I track products, methods, and results",
            ],
          },
        ],
        map: [
          "The Blank Slate",
          "The Guesser",
          "The Almost Girl",
          "The Polished Standard",
        ],
        results: {
          "The Blank Slate": {
            line: "You don\u2019t have a routine yet. That\u2019s not failure \u2014 it\u2019s opportunity.",
            shift: [
              "Stop guessing and start with the simplest possible system",
            ],
            start: [
              "Get three products: a gentle shampoo, a conditioner, and a leave-in or oil",
              "Wash day 1: shampoo the scalp, condition the ends, air dry. That\u2019s it.",
              "Repeat this exact routine for 2 weeks before adding anything else",
            ],
          },
          "The Guesser": {
            line: "You have products but no system. It\u2019s time to organize the chaos.",
            shift: [
              "The issue isn\u2019t your products \u2014 it\u2019s that you\u2019re using them without a plan",
            ],
            start: [
              "Assign each product a role: cleanse, condition, style, or protect",
              "If a product doesn\u2019t serve one of those roles clearly, remove it from your rotation",
              "Follow the 4-step sequence every wash day for 3 weeks",
            ],
          },
          "The Almost Girl": {
            line: "You\u2019re close. A few small adjustments and your hair routine locks in.",
            shift: [
              "You have good habits \u2014 now refine the details that make the difference",
            ],
            start: [
              "Switch to a microfiber towel if you haven\u2019t already",
              "Add a weekly treatment: deep conditioning or a scalp treatment",
              "Start a simple hair diary \u2014 3 weeks of notes will show you exactly what to optimize",
            ],
          },
          "The Polished Standard": {
            line: "Your routine is solid. It\u2019s time to refine, not rebuild.",
            shift: [
              "You\u2019ve done the hard part \u2014 now it\u2019s about precision and consistency",
            ],
            start: [
              "Rotate your deep treatment based on what your hair needs that week: moisture, protein, or clarifying",
              "Experiment with your scent layer \u2014 a finishing hair mist that makes your routine unforgettable",
              "Teach someone else what you know \u2014 this kind of intelligence multiplies when shared",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // SKIN 1: The Soft Skin Method
    // -------------------------------------------
    "skin-soft": {
      category: "skin",
      title: "The Soft Skin Method",
      subtitle: "What happens after your shower changes everything.",
      intro:
        "Your skin\u2019s softness isn\u2019t determined by the products you buy. It\u2019s determined by when and how you apply them. This method costs nothing extra \u2014 just better timing.",
      cards: [
        [
          "The 60-Second Window",
          "Your skin absorbs moisture best within 60 seconds of leaving the shower. After that, the surface closes. Everything you apply sits on top instead of sinking in.",
        ],
        [
          "The Coconut Oil Method",
          "Apply coconut oil to damp skin \u2014 not dry. The water on your skin helps it spread thin and absorb deep. This is not greasy when done right.",
        ],
        [
          "The Forgotten Areas",
          "Elbows. Knees. Ankles. The tops of your feet. The backs of your arms. These are the areas that age fastest and get moisturized least.",
        ],
        [
          "The Seal-It-In Technique",
          "Oil first on damp skin, then a cream or lotion on top to seal. This two-layer method holds moisture for 3x longer than lotion alone.",
        ],
        [
          "Soft Skin Changes How You Carry Yourself",
          "When your skin feels good under your clothes, you move differently. You touch your own arm without thinking. That\u2019s what self-care actually feels like.",
        ],
      ],
      quiz: {
        title: "What\u2019s Your Skin Texture Profile?",
        subtitle: "6 questions. Let\u2019s see what your body skin really needs.",
        questions: [
          {
            q: "How does your skin feel 2 hours after showering?",
            opts: [
              "Still soft and hydrated",
              "Fine but nothing special",
              "Tight or slightly dry",
              "Dry, rough, or ashy",
            ],
          },
          {
            q: "When do you apply body moisturizer?",
            opts: [
              "Immediately after showering, while still damp",
              "After I\u2019ve dried off completely",
              "Sometimes \u2014 when I remember",
              "I don\u2019t have a body moisturizing routine",
            ],
          },
          {
            q: "What do you currently use on your body?",
            opts: [
              "A rich body butter or oil",
              "Regular body lotion",
              "Whatever is in the bathroom",
              "Nothing consistently",
            ],
          },
          {
            q: "Touch your elbows right now. How do they feel?",
            opts: [
              "Smooth",
              "Slightly rough",
              "Dry and textured",
              "I don\u2019t want to answer that",
            ],
          },
          {
            q: "How would you describe your skin\u2019s overall texture?",
            opts: [
              "Soft and even most of the time",
              "Soft in some areas, rough in others",
              "Generally dry or inconsistent",
              "Rough, bumpy, or perpetually dehydrated",
            ],
          },
          {
            q: "How consistent is your body care routine?",
            opts: [
              "Daily \u2014 it\u2019s non-negotiable",
              "Most days \u2014 I try",
              "A few times a week at best",
              "I barely have one",
            ],
          },
        ],
        map: [
          "The Silk Type",
          "The Uneven Terrain",
          "The Sandpaper Cycle",
          "The Dry Desert",
        ],
        results: {
          "The Silk Type": {
            line: "Your skin is naturally cooperative. You just need to maintain what you have.",
            shift: [
              "Don\u2019t get complacent \u2014 even good skin needs consistent care to stay that way",
            ],
            start: [
              "Keep your damp-skin application habit \u2014 it\u2019s doing more than you realize",
              "Add a weekly exfoliation to keep the texture smooth",
              "Try layering oil under your lotion for even deeper softness",
            ],
          },
          "The Uneven Terrain": {
            line: "Some areas are soft, others are crying for help. You need targeted attention, not a blanket approach.",
            shift: [
              "Stop treating your entire body the same way \u2014 different zones need different care",
            ],
            start: [
              "Use a richer product (oil or butter) on elbows, knees, and ankles specifically",
              "Apply your regular lotion to the rest while skin is still damp",
              "Exfoliate the rough areas once a week with a gentle scrub or washcloth",
            ],
          },
          "The Sandpaper Cycle": {
            line: "Your skin gets dry, you moisturize, it dries again. The cycle needs to break \u2014 with timing.",
            shift: [
              "You\u2019re probably moisturizing at the wrong time \u2014 that\u2019s why it doesn\u2019t last",
            ],
            start: [
              "Apply moisturizer within 60 seconds of stepping out of the shower \u2014 on damp skin",
              "Use the seal method: oil on damp skin first, cream on top",
              "Stop using hot water \u2014 warm is enough. Hot water strips your skin barrier",
            ],
          },
          "The Dry Desert": {
            line: "Your skin has been neglected for a while. It\u2019s not too late \u2014 but it needs consistent attention starting now.",
            shift: [
              "This isn\u2019t about buying expensive products \u2014 it\u2019s about doing the basics daily",
            ],
            start: [
              "Start tonight: after your shower, apply any oil or lotion to damp skin",
              "Do this every single day for 7 days. You\u2019ll feel the difference by day 4",
              "Add a thick layer of shea butter or petroleum jelly to your driest areas before bed",
              "Drink more water \u2014 dry skin often starts from the inside",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // SKIN 2: The Shower Awakening
    // -------------------------------------------
    "skin-shower": {
      category: "skin",
      title: "The Shower Awakening",
      subtitle: "Your shower is not just cleaning. It\u2019s a skin ritual.",
      intro:
        "Most women treat their shower like a task. Polished women treat it as the first act of self-care each day. Same time. Different intention.",
      cards: [
        [
          "Water Temperature Matters",
          "Hot water feels good but strips your skin\u2019s natural oils. Warm water cleanses without destroying your barrier. The last 30 seconds should be cool.",
        ],
        [
          "Over-Washing vs. Under-Washing",
          "You\u2019re probably scrubbing areas that need gentle care and skipping areas that need attention. Your face needs less. Your feet need more.",
        ],
        [
          "Exfoliation Timing",
          "Exfoliating every day damages your barrier. Once or twice a week is enough. Use a gentle scrub or washcloth \u2014 not those harsh plastic loofahs.",
        ],
        [
          "Listen to Your Skin Under Water",
          "Does it feel tight? You\u2019re using water that\u2019s too hot. Does it feel slippery after soap? You haven\u2019t rinsed enough. Your skin communicates in the shower \u2014 start paying attention.",
        ],
        [
          "The Ritual Reframe",
          "Take 30 extra seconds. Touch your skin intentionally. Notice where it\u2019s rough, where it\u2019s soft, where it needs care. Awareness is the first step of every transformation.",
        ],
      ],
      quiz: {
        title: "How Aware Are You in the Shower?",
        subtitle:
          "6 questions. Most women are on autopilot. Let\u2019s find out where you are.",
        questions: [
          {
            q: "How long does your typical shower take?",
            opts: [
              "Under 5 minutes \u2014 in and out",
              "5\u201310 minutes \u2014 standard",
              "10\u201315 minutes \u2014 I take my time",
              "15+ minutes \u2014 it\u2019s my thinking time",
            ],
          },
          {
            q: "What temperature is your shower water usually?",
            opts: [
              "As hot as it goes",
              "Hot \u2014 I like the steam",
              "Warm \u2014 comfortable but not scalding",
              "I vary it \u2014 warm to wash, cool to finish",
            ],
          },
          {
            q: "How do you wash your body?",
            opts: [
              "Quick scrub with soap and hands \u2014 done",
              "Washcloth or loofah, same routine every time",
              "I pay attention to different areas and adjust",
              "I have a specific order and method I follow",
            ],
          },
          {
            q: "How often do you exfoliate in the shower?",
            opts: [
              "What counts as exfoliating?",
              "Rarely or never",
              "Once or twice a week",
              "I have a schedule for it",
            ],
          },
          {
            q: "Do you notice how your skin feels while you\u2019re showering?",
            opts: [
              "No \u2014 I\u2019m usually thinking about other things",
              "Sometimes \u2014 if something feels off",
              "Yes \u2014 I notice tightness, smoothness, or roughness",
              "Always \u2014 it\u2019s how I decide what my skin needs that day",
            ],
          },
          {
            q: "What do you do immediately after turning off the water?",
            opts: [
              "Towel off quickly and get dressed",
              "Dry off and maybe apply lotion if I remember",
              "Pat dry and moisturize while my skin is damp",
              "I have a full post-shower sequence",
            ],
          },
        ],
        map: [
          "The Autopilot",
          "The Rusher",
          "The Over-Scrubber",
          "The Ritual Bather",
        ],
        results: {
          "The Autopilot": {
            line: "Your shower is mechanical. You go in, you come out. Your skin never gets a say.",
            shift: [
              "You don\u2019t need a longer shower \u2014 you need a more intentional one",
            ],
            start: [
              "This week: turn the water to warm instead of hot. Notice what your skin feels like",
              "Spend 10 extra seconds on areas you usually skip: neck, behind ears, ankles",
              "After you turn off the water, pause. Touch your skin. Is it tight? Smooth? That\u2019s data.",
            ],
          },
          "The Rusher": {
            line: "Speed isn\u2019t the problem. Attention is. You can shower in 5 minutes and still be intentional.",
            shift: [
              "You\u2019re not too busy for good skin \u2014 you\u2019re just prioritizing speed over awareness",
            ],
            start: [
              "Keep your quick shower \u2014 but add one ritual: moisturize on damp skin immediately after",
              "Switch from hot to warm water \u2014 your skin barrier will thank you",
              "Exfoliate once a week \u2014 pick a day and make it part of the routine",
            ],
          },
          "The Over-Scrubber": {
            line: "You\u2019re doing too much. Your enthusiasm is real but your skin barrier is paying the price.",
            shift: [
              "More scrubbing does not mean cleaner \u2014 it means more damage",
            ],
            start: [
              "Reduce exfoliation to max 2x per week",
              "Replace your harsh loofah with a soft washcloth",
              "Use a gentle, fragrance-free body wash \u2014 your skin doesn\u2019t need to be stripped to be clean",
            ],
          },
          "The Ritual Bather": {
            line: "You\u2019ve turned your shower into a practice. Your skin trusts you. Now refine the details.",
            shift: [
              "You\u2019re already ahead \u2014 focus on seasonal adjustments and deeper products",
            ],
            start: [
              "Adjust your routine seasonally: more moisture in winter, lighter products in summer",
              "Try ending every shower with 15 seconds of cool water \u2014 it tightens pores and boosts circulation",
              "Invest in a shower filter if you have hard water \u2014 mineral buildup affects skin texture over time",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // SKIN 3: Timing Is Everything
    // -------------------------------------------
    "skin-timing": {
      category: "skin",
      title: "Timing Is Everything",
      subtitle: "The right product at the wrong time is the wrong product.",
      intro:
        "You already own products that work. They\u2019re just not working because of when you use them. Timing is the invisible variable no one talks about.",
      cards: [
        [
          "The 60-Second Rule",
          "After washing your face or body, you have about 60 seconds before your skin\u2019s absorption window closes. Moisturize on damp skin \u2014 always.",
        ],
        [
          "Morning vs. Evening",
          "Morning skin needs protection: lightweight moisturizer, SPF. Evening skin needs repair: richer creams, oils, active ingredients. Same skin, different needs.",
        ],
        [
          "Layering Order",
          "Thinnest to thickest. Water-based products first, oils last. If you put oil before serum, the serum can\u2019t penetrate. Order changes everything.",
        ],
        [
          "The Touch Test",
          "Rub your fingers together after applying. If your skin feels tacky, the product is sitting on top. If it feels smooth, it absorbed. That\u2019s how you know your timing is right.",
        ],
      ],
      quiz: {
        title: "Is Your Moisture Routine Actually Working?",
        subtitle:
          "6 questions. Find out if your products are absorbing or just sitting there.",
        questions: [
          {
            q: "When do you usually apply moisturizer to your face?",
            opts: [
              "Right after washing, while still damp",
              "After drying off completely",
              "Whenever I get around to it",
              "I don\u2019t have a regular pattern",
            ],
          },
          {
            q: "Do you use different products in the morning vs. evening?",
            opts: [
              "Yes \u2014 my AM and PM routines are different",
              "I use the same products but I know I probably shouldn\u2019t",
              "I only do skincare at one time of day",
              "I don\u2019t have a routine for either",
            ],
          },
          {
            q: "In what order do you apply your face products?",
            opts: [
              "Thinnest to thickest \u2014 serum, moisturizer, oil",
              "Whatever I grab first",
              "I only use one product so order doesn\u2019t apply",
              "I\u2019m not sure what the right order is",
            ],
          },
          {
            q: "After applying your moisturizer, how does your skin feel 30 minutes later?",
            opts: [
              "Hydrated and smooth \u2014 it absorbed well",
              "A bit greasy or filmy",
              "Dry again \u2014 like it didn\u2019t last",
              "I never check",
            ],
          },
          {
            q: "Do you use SPF in the morning?",
            opts: [
              "Every single day",
              "When I remember or when it\u2019s sunny",
              "Rarely",
              "No \u2014 I don\u2019t own sunscreen for my face",
            ],
          },
          {
            q: "How would you describe your current skincare timing?",
            opts: [
              "Dialed in \u2014 I know when to apply what",
              "Good but inconsistent",
              "Random \u2014 there\u2019s no system",
              "I didn\u2019t know timing mattered until now",
            ],
          },
        ],
        map: [
          "The Locked-In Type",
          "The Wrong-Order Type",
          "The Too-Late Type",
          "The Unaware Type",
        ],
        results: {
          "The Locked-In Type": {
            line: "Your timing is solid. Your products are actually reaching your skin. Now optimize.",
            shift: [
              "You\u2019re in maintenance mode \u2014 small upgrades compound from here",
            ],
            start: [
              "Experiment with layering a facial oil as the last step in your PM routine",
              "Track how your skin responds to products across your menstrual cycle",
              "Consider upgrading one product to a more active formula now that your timing supports absorption",
            ],
          },
          "The Wrong-Order Type": {
            line: "Your products are good. Your sequence isn\u2019t. A simple reorder will change your results.",
            shift: [
              "You\u2019re spending money on products that can\u2019t reach your skin because of layering mistakes",
            ],
            start: [
              "Reorder: cleanser \u2192 toner/essence \u2192 serum \u2192 moisturizer \u2192 oil \u2192 SPF (AM only)",
              "Wait 30 seconds between each layer for better absorption",
              "Drop any product that\u2019s redundant \u2014 two moisturizers don\u2019t help if one blocks the other",
            ],
          },
          "The Too-Late Type": {
            line: "By the time you moisturize, your skin has already closed the window. Timing is the fix.",
            shift: [
              "It\u2019s not your products \u2014 it\u2019s the gap between washing and applying",
            ],
            start: [
              "Keep your moisturizer next to your sink \u2014 literally within arm\u2019s reach",
              "Apply within 60 seconds of washing, on damp skin",
              "If your skin feels tight before you moisturize, you\u2019ve already waited too long",
            ],
          },
          "The Unaware Type": {
            line: "You didn\u2019t know timing mattered. Now you do. That\u2019s the whole first step.",
            shift: [
              "Awareness alone will change your skin \u2014 you just need the simplest system",
            ],
            start: [
              "Start with this: wash face, apply moisturizer on damp skin, done. AM and PM.",
              "One product is enough to start \u2014 pick a moisturizer you like and use it consistently",
              "After 2 weeks of consistent timing, your skin will already feel different",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // FEMININE CARE 1: The Flat Stomach Blueprint
    // -------------------------------------------
    "care-flat-stomach": {
      category: "feminine-care",
      title: "The Flat Stomach Blueprint",
      subtitle: "It starts in the kitchen, heals in the gut.",
      intro:
        "You\u2019ve done the crunches. You\u2019ve skipped the meals. And still \u2014 you wake up bloated, puffy, uncomfortable in clothes that fit you last week. It was never about discipline. It was about inflammation.",
      cards: [
        [
          "The Truth About Flat",
          "A flat stomach isn\u2019t about being thin. It\u2019s about your gut not being at war with what you feed it.",
        ],
        [
          "The Silent Triggers",
          "Dairy. Carbonated drinks. Chewing gum. Eating too fast. These aren\u2019t \u201cbad\u201d \u2014 they\u2019re quiet triggers most women never connect to their stomach.",
        ],
        [
          "The Morning Reset",
          "Warm lemon water before anything else. It wakes your digestive system up gently instead of shocking it.",
        ],
        [
          "The Bloat Clock",
          "Bloating isn\u2019t random. Track it for 5 days. You\u2019ll find the pattern \u2014 it\u2019s almost always tied to a specific food, time, or habit.",
        ],
        [
          "Water Timing",
          "Drinking water during meals dilutes digestion. Drink 30 minutes before eating or 1 hour after.",
        ],
        [
          "The Stress Belly",
          "Cortisol stores fat in your midsection. No amount of clean eating fixes a nervous system that never rests.",
        ],
      ],
      quiz: {
        title: "What\u2019s Your Bloat Pattern?",
        subtitle:
          "6 questions. Honest answers only. Let\u2019s find out what\u2019s really going on.",
        questions: [
          {
            q: "When does your stomach feel the worst?",
            opts: [
              "First thing in the morning \u2014 I wake up puffy",
              "After meals \u2014 especially lunch or dinner",
              "At the end of the day \u2014 it builds gradually",
              "Randomly \u2014 I can\u2019t find a pattern",
            ],
          },
          {
            q: "How often do you feel bloated in a typical week?",
            opts: [
              "Almost every day",
              "3\u20134 times a week",
              "Once or twice, usually after specific foods",
              "Rarely, but when it hits, it\u2019s intense",
            ],
          },
          {
            q: "What does your water intake actually look like?",
            opts: [
              "I forget until the afternoon",
              "I drink a lot \u2014 but mostly during meals",
              "Decent \u2014 a few glasses spread through the day",
              "I drink plenty but still feel bloated",
            ],
          },
          {
            q: "How would you describe your stress level right now?",
            opts: [
              "High \u2014 I carry tension constantly",
              "Moderate \u2014 it comes and goes in waves",
              "Low \u2014 I\u2019m relatively calm day to day",
              "I don\u2019t feel stressed but my body acts like I am",
            ],
          },
          {
            q: "Which of these do you consume most days?",
            opts: [
              "Coffee on an empty stomach",
              "Bread, pasta, or processed snacks",
              "Dairy \u2014 milk, cheese, yogurt",
              "Mostly whole foods but my stomach still reacts",
            ],
          },
          {
            q: "When you eat clean for a few days, what happens?",
            opts: [
              "I don\u2019t notice much difference",
              "My stomach calms down almost immediately",
              "I feel better but it comes back the moment I stop",
              "I haven\u2019t been consistent enough to know",
            ],
          },
        ],
        map: [
          "The Stress Bloater",
          "The Food Reactor",
          "The Cycle Bloater",
          "The Hidden Inflamer",
        ],
        results: {
          "The Stress Bloater": {
            line: "Your stomach isn\u2019t reacting to food. It\u2019s reacting to your nervous system.",
            shift: [
              "Stop blaming your diet for something your nervous system is doing",
              "Coffee on an empty stomach is spiking your cortisol before the day begins",
            ],
            start: [
              "Warm water with lemon before any caffeine \u2014 every morning",
              "5 minutes of slow breathing before bed to lower cortisol",
              "Eat within 90 minutes of waking \u2014 don\u2019t let stress hormones be your fuel",
              "Track bloat against stress, not food",
            ],
          },
          "The Food Reactor": {
            line: "Your body is trying to tell you something after every meal. It\u2019s time to listen.",
            shift: [
              "Bloating after meals is a signal, not a default",
            ],
            start: [
              "5-day food + bloat journal: what you ate and how you felt 2 hours later",
              "Eliminate dairy, gluten, and carbonated drinks for one week",
              "Reintroduce one at a time \u2014 your body will answer clearly",
              "Eat slowly. Chewing more = less air swallowed = less bloating",
            ],
          },
          "The Cycle Bloater": {
            line: "You know what works. You just can\u2019t seem to stay there.",
            shift: [
              "Stop treating clean eating as a phase \u2014 make it your baseline",
            ],
            start: [
              "Build 3 default meals you can fall back on without thinking",
              "Prep for your weakest day of the week \u2014 that\u2019s where the cycle breaks",
              "Aim for 5 out of 7 days clean \u2014 that\u2019s where results hold",
              "You\u2019re not starting over. You\u2019re returning to a standard you already know works",
            ],
          },
          "The Hidden Inflamer": {
            line: "You\u2019re doing things right on the surface. The inflammation is deeper.",
            shift: [
              "Look beyond food \u2014 sleep, artificial sweeteners, and gut imbalance may be the issue",
            ],
            start: [
              "Remove artificial sweeteners for 2 weeks (check \u201chealth food\u201d labels)",
              "Add a daily probiotic or fermented food",
              "Eat dinner 3 hours before bed \u2014 your gut repairs overnight",
              "Try a 2-week elimination of top 5 triggers with conscious reintroduction",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // FEMININE CARE 2: The Quiet System
    // -------------------------------------------
    "care-quiet-system": {
      category: "feminine-care",
      title: "The Quiet System",
      subtitle:
        "The things no one talks about \u2014 but every polished woman has handled.",
      intro:
        "There are things about your body that no one ever sat you down to explain. Not your doctor. Not your mother. Not the internet. This module is that conversation.",
      cards: [
        [
          "The Unspoken Routine",
          "Every woman who looks like she \u201chas it together\u201d has one thing in common: a consistent digestive rhythm. It affects her skin, energy, and mood.",
        ],
        [
          "What Regular Actually Means",
          "Once a day, ideally in the morning, with ease. If that\u2019s not you \u2014 you\u2019re not broken. You\u2019re just uninformed about what your body needs.",
        ],
        [
          "The Morning Protocol",
          "Warm water. Movement. A calm 10 minutes before rushing. Your body needs a signal that it\u2019s safe to release.",
        ],
        [
          "The Three Quiet Levers",
          "Fiber moves things. Water softens the process. Movement stimulates the muscles that push. Miss one and the system slows.",
        ],
        [
          "The Gut-Skin Connection",
          "Breakouts on your chin? Dull skin? Fatigue? Check your gut. Digestion doesn\u2019t stay in your stomach \u2014 it shows on your face.",
        ],
      ],
      quiz: {
        title: "How Healthy Is Your Digestive Rhythm?",
        subtitle:
          "6 questions. Completely private. Let\u2019s see where you really are.",
        questions: [
          {
            q: "How consistent is your daily digestive rhythm?",
            opts: [
              "I don\u2019t have one \u2014 it\u2019s different every day",
              "It happens but I can\u2019t predict when",
              "Most days I have a pattern, but it breaks easily",
              "Very consistent \u2014 same time, same ease, almost daily",
            ],
          },
          {
            q: "What does your morning routine include?",
            opts: [
              "Coffee and rush \u2014 no time for anything else",
              "I eat something but don\u2019t think about digestion",
              "I drink water first, then eat within an hour",
              "Warm water, movement, and a meal \u2014 it\u2019s built into my rhythm",
            ],
          },
          {
            q: "How much fiber are you realistically eating?",
            opts: [
              "Barely any \u2014 mostly processed or simple foods",
              "Some \u2014 but I don\u2019t think about it intentionally",
              "I try to include vegetables and whole grains most days",
              "I\u2019m intentional \u2014 greens, fruit, whole grains daily",
            ],
          },
          {
            q: "How much water do you drink in a day?",
            opts: [
              "Very little \u2014 I forget until I\u2019m thirsty",
              "Maybe 3\u20134 glasses if I remember",
              "Around 6\u20138 glasses, more or less",
              "I\u2019m naturally consistent \u2014 8+ glasses daily",
            ],
          },
          {
            q: "Do you move your body in the morning?",
            opts: [
              "Almost never \u2014 mornings are for surviving",
              "Sometimes \u2014 a walk or stretch if I have time",
              "I try \u2014 even 10 minutes most days",
              "Yes \u2014 daily movement is non-negotiable",
            ],
          },
          {
            q: "When your body sends a digestive signal, what do you do?",
            opts: [
              "Ignore it \u2014 I\u2019m busy, I\u2019ll go later",
              "Delay it \u2014 I wait until it\u2019s convenient",
              "Respond when I can \u2014 usually within a reasonable window",
              "Respond immediately \u2014 I\u2019ve learned not to override it",
            ],
          },
        ],
        map: [
          "The Irregular",
          "The Unconscious",
          "The Almost Consistent",
          "The Clockwork Woman",
        ],
        results: {
          "The Irregular": {
            line: "Your body doesn\u2019t have a rhythm yet \u2014 but it wants one. Desperately.",
            shift: [
              "Stop treating digestion as something that just happens to you \u2014 it\u2019s a system you can train",
            ],
            start: [
              "Warm water within 10 minutes of waking \u2014 before coffee, before food",
              "A 10-minute walk or stretch in the morning",
              "One fiber-rich food at every meal for 7 days",
              "Same wake time every day \u2014 your digestive clock mirrors your sleep clock",
            ],
          },
          "The Unconscious": {
            line: "It\u2019s not that your body isn\u2019t working. It\u2019s that you\u2019ve never paid attention to it.",
            shift: [
              "Start noticing. When did you last go? How did it feel? This awareness alone changes everything",
            ],
            start: [
              "7-day digestive journal: time, ease, and what you ate the meal before",
              "Increase water by 2 glasses per day",
              "Add one moment of stillness after each meal \u2014 5 minutes of not rushing helps your gut process",
            ],
          },
          "The Almost Consistent": {
            line: "You\u2019re close. The rhythm is forming \u2014 it just needs protection.",
            shift: [
              "Identify your rhythm breakers \u2014 the specific situations that throw you off",
            ],
            start: [
              "Build a non-negotiable morning sequence: water \u2192 movement \u2192 food",
              "On disrupted days, keep one anchor: warm water first thing",
              "Increase fiber on your weakest days, not your strongest",
            ],
          },
          "The Clockwork Woman": {
            line: "Your body trusts you. You\u2019ve built the foundation. Now refine.",
            shift: [
              "Move from maintenance to optimization",
            ],
            start: [
              "Experiment with eating your largest meal earlier in the day",
              "Add fermented foods 3x per week for probiotic support",
              "Notice how your cycle affects your rhythm \u2014 track for 2 months",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // FEMININE CARE 3: Eating Like a Woman Who Knows
    // -------------------------------------------
    "care-eating": {
      category: "feminine-care",
      title: "Eating Like a Woman Who Knows",
      subtitle: "You don\u2019t need a diet. You need a standard.",
      intro:
        "A woman who eats well doesn\u2019t count calories. She doesn\u2019t follow trends. She just knows \u2014 what makes her feel good, what makes her glow, and what\u2019s quietly working against her.",
      cards: [
        [
          "It\u2019s Not a Diet",
          "Clean eating isn\u2019t restriction. It\u2019s clarity. Knowing the difference between food that fuels you and food that inflames you.",
        ],
        [
          "The Five Silent Agers",
          "Refined sugar. Processed seed oils. Excess dairy. Alcohol. Artificial sweeteners. You don\u2019t have to quit all five \u2014 but you should know they\u2019re affecting you.",
        ],
        [
          "The 7-Day Shift",
          "Swap white bread for sourdough. Swap soda for sparkling water. Swap frying for baking. In 7 days your body will feel different. In 14, it\u2019s visible.",
        ],
        [
          "Eating for Your Cycle",
          "Week 1: iron and warmth. Week 3: lighter meals and hydration. Your cycle is a blueprint. Eat with it, not against it.",
        ],
        [
          "The Plate Method",
          "Half vegetables. Quarter protein. Quarter complex carb. No measuring. No math. Just a visual standard for every meal.",
        ],
      ],
      quiz: {
        title: "What\u2019s Your Eating Identity?",
        subtitle: "6 questions. No judgment. Just clarity.",
        questions: [
          {
            q: "What does a typical weekday meal look like for you?",
            opts: [
              "Whatever\u2019s fastest \u2014 I eat to not be hungry",
              "I skip meals more than I eat them",
              "I try to be healthy but I\u2019m overwhelmed by the advice",
              "I eat with intention \u2014 whole foods, balanced, mostly consistent",
              "I listen to my body and eat what feels right",
            ],
          },
          {
            q: "How do you feel 2 hours after eating?",
            opts: [
              "Heavy, sluggish, or bloated",
              "Hungry again \u2014 like it didn\u2019t stick",
              "Fine, but I\u2019m never sure if I ate the right thing",
              "Energized and satisfied",
              "Steady \u2014 I don\u2019t think about food until the next mealtime",
            ],
          },
          {
            q: "What\u2019s your relationship with sugar right now?",
            opts: [
              "I crave it daily and usually give in",
              "I don\u2019t eat much of anything including sugar",
              "I\u2019m trying to cut back but I don\u2019t know what to replace it with",
              "I\u2019ve mostly removed added sugar",
              "I eat something sweet when I want it, without guilt",
            ],
          },
          {
            q: "How often do you cook your own meals?",
            opts: [
              "Rarely \u2014 takeout, snacks, or whatever\u2019s around",
              "I don\u2019t eat enough to feel like cooking matters",
              "Sometimes \u2014 but I don\u2019t know what to make that\u2019s healthy",
              "Most days \u2014 I have a rotation of go-to recipes",
              "Often \u2014 cooking is how I care for myself",
            ],
          },
          {
            q: "When you hear \u201cclean eating,\u201d what do you feel?",
            opts: [
              "Overwhelmed \u2014 it sounds expensive and complicated",
              "Guilty \u2014 I know I should but I barely eat as it is",
              "Interested \u2014 I want to but need a simple starting point",
              "Aligned \u2014 I already eat this way, more or less",
              "Neutral \u2014 I don\u2019t follow labels, I follow my body",
            ],
          },
          {
            q: "What would change your life most right now?",
            opts: [
              "Knowing what to eat without thinking so hard",
              "Actually eating enough, consistently",
              "A simple framework that doesn\u2019t feel like a diet",
              "Fine-tuning what I already do \u2014 small upgrades",
              "Nothing drastic \u2014 I\u2019m mostly where I want to be",
            ],
          },
        ],
        map: [
          "The Convenience Queen",
          "The Undereater",
          "The Health-Curious",
          "The Quiet Disciplined",
          "The Intuitive Eater",
        ],
        results: {
          "The Convenience Queen": {
            line: "You\u2019re not lazy. You\u2019re unsupported. Nobody gave you a food system.",
            shift: [
              "Convenience doesn\u2019t have to mean low quality \u2014 it means building a system that makes healthy food the easiest option",
            ],
            start: [
              "Pick 3 default meals you can make in under 15 minutes. Rotate weekly.",
              "Sunday prep: wash greens, cook rice, portion protein. 20 minutes.",
              "Replace one processed snack per day with fruit, nuts, or eggs",
            ],
          },
          "The Undereater": {
            line: "Skipping meals isn\u2019t discipline. Your body has learned to stop asking.",
            shift: [
              "Eating is not optional self-care \u2014 it\u2019s the infrastructure everything else runs on",
            ],
            start: [
              "Set 3 meal alarms for one week \u2014 eat something at each, even small",
              "Start with easy breakfasts: overnight oats, smoothie, toast with avocado and egg",
              "Eat before you\u2019re hungry \u2014 your hunger signals have gone quiet",
            ],
          },
          "The Health-Curious": {
            line: "You want to eat well. You\u2019re just drowning in information.",
            shift: [
              "Stop researching and start doing. One change per week beats a perfect plan you never execute.",
            ],
            start: [
              "Week 1: The plate method for every meal. Half veg, quarter protein, quarter carb.",
              "Week 2: Remove one of the 5 silent agers (start with the easiest)",
              "Week 3: Add one fermented or probiotic food daily",
            ],
          },
          "The Quiet Disciplined": {
            line: "You don\u2019t perform health. You just live it. That\u2019s power.",
            shift: [
              "Move from consistent to cyclical \u2014 eating for your hormonal cycle is the next layer",
            ],
            start: [
              "Learn the 4-phase cycle eating framework",
              "Experiment with largest meal at lunch, lighter dinner",
              "Add one new anti-inflammatory ingredient per week",
            ],
          },
          "The Intuitive Eater": {
            line: "You\u2019ve stopped fighting your body and started listening. That\u2019s the most advanced place to be.",
            shift: [
              "Deepen the connection between food, your cycle, and seasonal shifts",
            ],
            start: [
              "Track food alongside your cycle for 2 months \u2014 patterns will emerge",
              "Try one new whole food per week you\u2019ve never cooked with",
              "Be the woman in your circle who normalizes eating without anxiety",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // BEAUTY 1: The Less Makeup Philosophy
    // -------------------------------------------
    "beauty-less-makeup": {
      category: "beauty-layer",
      title: "The Less Makeup Philosophy",
      subtitle: "The goal isn\u2019t no makeup. It\u2019s no performance.",
      intro:
        "Looking polished doesn\u2019t require 12 products. It requires knowing your face \u2014 what to enhance, what to leave alone, and when less creates more impact than more ever could.",
      cards: [
        [
          "Not \u201cNo Makeup\u201d \u2014 No Performance",
          "The goal isn\u2019t to stop wearing makeup. It\u2019s to stop using it as a mask. Enhance, don\u2019t hide.",
        ],
        [
          "Skin First, Always",
          "Foundation can\u2019t fix what skincare should handle. Skin that looks good without coverage is built through routine, not concealer.",
        ],
        [
          "The 3-Product Face",
          "Brows. Lashes. Lips. If you can only do three things, these are the three that structure your entire face.",
        ],
        [
          "When Less Is More Powerful",
          "A woman in a meeting with clear skin, groomed brows, and a subtle lip reads as more put-together than a full beat. Context is everything.",
        ],
        [
          "The Identity Shift",
          "Confidence without coverage isn\u2019t about bravery. It\u2019s about building a face you trust \u2014 through skincare, grooming, and knowing your features.",
        ],
      ],
      quiz: {
        title: "What\u2019s Your Makeup Relationship?",
        subtitle:
          "6 questions. Let\u2019s find out if your makeup is serving you or shielding you.",
        questions: [
          {
            q: "How many products do you use on a typical day?",
            opts: [
              "0 \u2014 I don\u2019t wear makeup",
              "1\u20133 \u2014 just the basics",
              "4\u20137 \u2014 a moderate routine",
              "8+ \u2014 I like a full face",
            ],
          },
          {
            q: "Why do you wear makeup?",
            opts: [
              "I don\u2019t \u2014 I don\u2019t know where to start",
              "To cover things I don\u2019t like",
              "To look polished and professional",
              "Because I enjoy the creative process",
            ],
          },
          {
            q: "Could you leave the house bare-faced and feel okay?",
            opts: [
              "Yes \u2014 I do it all the time",
              "I could, but I\u2019d feel exposed",
              "Only for errands \u2014 not for anything important",
              "No \u2014 I don\u2019t feel like myself without makeup",
            ],
          },
          {
            q: "What\u2019s your relationship with foundation?",
            opts: [
              "I don\u2019t own any",
              "I wear it daily \u2014 I need the coverage",
              "I use a light tint or BB cream sometimes",
              "I\u2019ve moved away from it \u2014 I focus on skincare instead",
            ],
          },
          {
            q: "Do you know which of your features are your strongest?",
            opts: [
              "Not really \u2014 I haven\u2019t thought about it",
              "I know what I don\u2019t like more than what I do like",
              "I have a general idea",
              "Yes \u2014 I know exactly what to enhance",
            ],
          },
          {
            q: "If you could only do one thing to your face before going out, what would it be?",
            opts: [
              "I don\u2019t know \u2014 I\u2019d probably skip it",
              "Concealer or foundation",
              "Brows or mascara",
              "Lipstick or lip tint",
            ],
          },
        ],
        map: [
          "The Bare Beginner",
          "The Hider",
          "The Minimalist in Training",
          "The Effortless Face",
        ],
        results: {
          "The Bare Beginner": {
            line: "You want to start but you don\u2019t know where. That\u2019s the most honest place to begin.",
            shift: [
              "You don\u2019t need to learn \u201cmakeup\u201d \u2014 you need to learn your face",
            ],
            start: [
              "Start with brows: a clear brow gel or light pencil to define your natural shape",
              "Add mascara: one coat that opens your eyes",
              "A tinted lip balm in a shade close to your natural lip color",
            ],
          },
          "The Hider": {
            line: "You\u2019re using makeup to cover, not to enhance. It\u2019s time to shift the intention.",
            shift: [
              "Invest in skincare so your skin doesn\u2019t need coverage \u2014 that\u2019s the real fix",
            ],
            start: [
              "Swap heavy foundation for a tinted moisturizer or skin tint",
              "Use concealer only where needed \u2014 under eyes, around nose \u2014 not all over",
              "Focus one month on skincare: cleanser, moisturizer, SPF. Watch what changes.",
            ],
          },
          "The Minimalist in Training": {
            line: "You\u2019re reducing but unsure what to keep. Let\u2019s simplify with intention.",
            shift: [
              "The products you keep should each have a clear purpose",
            ],
            start: [
              "Identify your 3 non-negotiables \u2014 the products that make you feel finished",
              "Remove anything you add out of habit but don\u2019t actually notice",
              "Build a 5-minute face you can do with your eyes closed",
            ],
          },
          "The Effortless Face": {
            line: "You know your face. You know your features. Less is more \u2014 and you\u2019ve mastered it.",
            shift: [
              "Maintain what works and explore one new element per season",
            ],
            start: [
              "Experiment with a new lip shade that shifts your look without adding steps",
              "Try cream products instead of powder for an even more natural finish",
              "Share your routine with someone who\u2019s still figuring it out \u2014 your simplicity is inspiring",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // BEAUTY 2: Day Face, Night Face
    // -------------------------------------------
    "beauty-day-night": {
      category: "beauty-layer",
      title: "Day Face, Night Face",
      subtitle: "Your day face and your night face are two different women.",
      intro:
        "The same makeup that looks fresh at 10am can look flat at 8pm. Context, lighting, and energy shift \u2014 your face should shift with them.",
      cards: [
        [
          "Two Faces, One Woman",
          "Day is about looking awake, fresh, and naturally polished. Night is about definition, warmth, and presence. Don\u2019t use the same approach for both.",
        ],
        [
          "The Soft Shift",
          "You don\u2019t need to redo your entire face. Three changes \u2014 lip color, lash intensity, and glow placement \u2014 take you from day to evening in 5 minutes.",
        ],
        [
          "Daytime Glow vs. Nighttime Definition",
          "Day: highlighter on cheekbones, light lip, natural brow. Night: deeper lip, defined lash line, contour or bronzer to add dimension.",
        ],
        [
          "Lighting Changes Everything",
          "Fluorescent light washes you out. Warm evening light deepens your features. What looks perfect at home may disappear under office lights. Check your face in the light you\u2019ll be seen in.",
        ],
        [
          "The 5-Minute Transition",
          "Deepen your lip. Add a second coat of mascara. Warm your cheeks with a bronzer or blush. That\u2019s the whole transition. Five minutes. Two different women.",
        ],
      ],
      quiz: {
        title: "Which Face Do You Default To?",
        subtitle: "6 questions. Find out how you show up \u2014 and where to shift.",
        questions: [
          {
            q: "Do you change your makeup between day and evening?",
            opts: [
              "No \u2014 same face all day",
              "I take makeup off but don\u2019t add anything for evening",
              "Sometimes \u2014 if I have a specific event",
              "Yes \u2014 I shift my look based on context",
            ],
          },
          {
            q: "How do you feel about your look under different lighting?",
            opts: [
              "I\u2019ve never really thought about it",
              "I look different in every mirror and it confuses me",
              "I know some lighting is better for me than others",
              "I adjust my makeup based on where I\u2019m going and the lighting there",
            ],
          },
          {
            q: "What\u2019s your go-to lip product?",
            opts: [
              "Clear lip balm or nothing",
              "A nude or MLBB shade \u2014 something subtle",
              "I have a day shade and a going-out shade",
              "I choose my lip based on the occasion and outfit",
            ],
          },
          {
            q: "When do you feel most \u201cdone\u201d?",
            opts: [
              "In the morning when I first apply",
              "I rarely feel \u201cdone\u201d honestly",
              "After work when I freshen up",
              "When I\u2019ve intentionally transitioned my look for the evening",
            ],
          },
          {
            q: "How comfortable are you with bolder makeup?",
            opts: [
              "I never wear bold makeup",
              "I\u2019d like to but I feel like it\u2019s too much",
              "I do it occasionally for events",
              "I love a bold lip or eye when the setting calls for it",
            ],
          },
          {
            q: "If you had to describe your default face in one word:",
            opts: ["Bare", "Safe", "Fresh", "Adaptive"],
          },
        ],
        map: [
          "The One-Look Woman",
          "The Day-Only Girl",
          "The Night Owl",
          "The Shape-Shifter",
        ],
        results: {
          "The One-Look Woman": {
            line: "Same face morning to midnight. It\u2019s time to learn the shift.",
            shift: [
              "You don\u2019t need to double your products \u2014 just learn 3 adjustments that change the energy",
            ],
            start: [
              "Keep your day face as-is. In the evening, add one thing: a deeper lip color",
              "Next, try adding warmth: a cream blush or bronzer on your cheekbones",
              "Practice the 5-minute transition at home until it feels natural",
            ],
          },
          "The Day-Only Girl": {
            line: "You show up polished by day but disappear by evening. Let\u2019s fix that.",
            shift: [
              "Evening doesn\u2019t require more effort \u2014 it requires different placement",
            ],
            start: [
              "Instead of removing your day makeup, build on it: add a lip, a lash, a glow",
              "Keep a small evening kit in your bag: one lip color, one mascara, one highlighter or blush",
              "Reframe evening makeup as an energy shift, not a chore",
            ],
          },
          "The Night Owl": {
            line: "You only show up for evening. Your day face deserves the same attention.",
            shift: [
              "Daytime polish is quieter but just as powerful \u2014 it\u2019s about looking intentional, not dramatic",
            ],
            start: [
              "Build a 3-minute morning face: tinted moisturizer, brow gel, lip balm",
              "Day makeup should make you look awake and fresh \u2014 not made up",
              "Save the boldness for evening but give your day face a foundation of care",
            ],
          },
          "The Shape-Shifter": {
            line: "You adapt effortlessly. Your face shifts with the room. Keep refining.",
            shift: [
              "You\u2019ve mastered the concept \u2014 now explore new products and techniques within your system",
            ],
            start: [
              "Try a new seasonal lip color that shifts your palette",
              "Experiment with cream vs. powder products for different light settings",
              "Teach a friend how to do the 5-minute transition \u2014 your fluency is a gift",
            ],
          },
        },
      },
    },

    // -------------------------------------------
    // BEAUTY 3: The Clean Canvas
    // -------------------------------------------
    "beauty-clean-canvas": {
      category: "beauty-layer",
      title: "The Clean Canvas",
      subtitle: "How you end the day matters as much as how you start it.",
      intro:
        "Sleeping in makeup is not laziness \u2014 it\u2019s silent damage. Your skin repairs overnight, but only if the canvas is truly clean. This module teaches you how to end each day right.",
      cards: [
        [
          "Skin Betrayal",
          "One night of sleeping in makeup can clog pores for a week. Your skin can\u2019t repair what it can\u2019t breathe through.",
        ],
        [
          "The Double Cleanse",
          "First cleanse: oil-based, dissolves makeup and sunscreen. Second cleanse: water-based, cleans the skin itself. One step can\u2019t do both jobs.",
        ],
        [
          "Eye Makeup Deserves Its Own Step",
          "Rubbing your eyes with a regular wipe stretches delicate skin. Use a dedicated eye makeup remover on a cotton pad. Press, hold, slide. Don\u2019t scrub.",
        ],
        [
          "The Overnight Repair",
          "Clean skin + a rich night cream or facial oil = 8 hours of active repair. Your skin does its best work between 10pm and 2am. Give it a clean surface.",
        ],
        [
          "What Clean Skin Does Overnight",
          "Cell turnover. Collagen production. Barrier repair. All of this happens while you sleep \u2014 but only on a clean canvas.",
        ],
      ],
      quiz: {
        title: "How Clean Is Your Canvas at Night?",
        subtitle:
          "6 questions. Let\u2019s find out if your nighttime routine is helping or hurting.",
        questions: [
          {
            q: "How do you typically remove your makeup at night?",
            opts: [
              "A makeup wipe and done",
              "Face wash with water",
              "Micellar water or a cleansing balm",
              "Double cleanse \u2014 oil cleanser then water cleanser",
            ],
          },
          {
            q: "How often do you go to bed with makeup still on?",
            opts: [
              "More than I\u2019d like to admit",
              "Occasionally \u2014 when I\u2019m too tired",
              "Rarely \u2014 I almost always wash my face",
              "Never \u2014 it\u2019s a non-negotiable",
            ],
          },
          {
            q: "How do you handle eye makeup removal?",
            opts: [
              "Same wipe or wash as the rest of my face",
              "I try to be gentle but I usually just rub it off",
              "I use a separate eye makeup remover",
              "Dedicated remover, cotton pad, press-and-hold technique",
            ],
          },
          {
            q: "What do you do after removing makeup?",
            opts: [
              "Nothing \u2014 I go to bed",
              "Maybe some moisturizer if I remember",
              "I apply a night cream or moisturizer",
              "Full nighttime routine: serum, moisturizer, eye cream, or facial oil",
            ],
          },
          {
            q: "How does your skin look when you wake up?",
            opts: [
              "Dull, congested, or broken out",
              "Okay but not great",
              "Generally clear and calm",
              "Fresh and hydrated \u2014 my overnight routine works",
            ],
          },
          {
            q: "How would you describe your nighttime skincare?",
            opts: [
              "Nonexistent",
              "Inconsistent \u2014 I do it when I feel like it",
              "Pretty solid \u2014 most nights I follow a routine",
              "Ritualistic \u2014 it\u2019s the best part of my evening",
            ],
          },
        ],
        map: [
          "The Wipe-and-Sleep",
          "The Partial Remover",
          "The Overcleaner",
          "The Night Ritualist",
        ],
        results: {
          "The Wipe-and-Sleep": {
            line: "One wipe isn\u2019t enough. Your skin is paying for the shortcut.",
            shift: [
              "A makeup wipe removes surface makeup but leaves residue, oil, and sunscreen in your pores",
            ],
            start: [
              "Replace the wipe with a cleansing balm \u2014 massage into dry skin, rinse off",
              "Follow with a gentle face wash \u2014 that\u2019s the double cleanse, and it takes 2 minutes",
              "Apply any moisturizer after \u2014 even basic. Your skin needs a repair layer overnight.",
            ],
          },
          "The Partial Remover": {
            line: "You\u2019re getting most of it off but missing the edges. The residue adds up.",
            shift: [
              "The makeup you don\u2019t see is the makeup clogging your pores",
            ],
            start: [
              "After cleansing, swipe a toner-soaked cotton pad across your face \u2014 check the pad. If it\u2019s tinted, you\u2019re not removing enough.",
              "Give extra attention to your hairline, jawline, and around your nose \u2014 residue hides there",
              "Use a dedicated eye makeup remover before cleansing your full face",
            ],
          },
          "The Overcleaner": {
            line: "You\u2019re thorough with removal but skipping the repair step. Clean skin without moisture is vulnerable skin.",
            shift: [
              "Removing makeup is only half the nighttime equation \u2014 repair is the other half",
            ],
            start: [
              "After your double cleanse, apply a hydrating serum while skin is damp",
              "Seal with a night cream or facial oil",
              "Your skin does its deepest repair between 10pm\u20132am \u2014 give it fuel, not just a clean surface",
            ],
          },
          "The Night Ritualist": {
            line: "Your canvas is clean. Your repair routine is active. You\u2019re already doing the work.",
            shift: [
              "Refine with seasonal adjustments and targeted treatments",
            ],
            start: [
              "Rotate your night serum based on skin needs: hydration, brightening, or texture",
              "Add a weekly overnight mask for deeper nourishment",
              "Track how your skin looks on mornings after you skipped routine vs. followed it \u2014 the difference is your motivation",
            ],
          },
        },
      },
    },
  };

  // =============================================
  // ROUTER
  // =============================================
  function getRoute() {
    var hash = window.location.hash || "#/";
    var parts = hash.replace("#/", "").split("/");
    return { page: parts[0] || "home", param: parts[1] || null };
  }

  function navigate() {
    var route = getRoute();
    var app = document.getElementById("app");
    app.style.opacity = "0";
    setTimeout(function () {
      switch (route.page) {
        case "home":
        case "":
          renderHome(app);
          break;
        case "category":
          renderCategory(app, route.param);
          break;
        case "module":
          renderModule(app, route.param);
          break;
        case "quiz":
          if (route.param === "entry") {
            renderEntryQuiz(app);
          } else {
            renderModuleQuiz(app, route.param);
          }
          break;
        default:
          renderHome(app);
      }
      app.style.opacity = "1";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 150);
  }

  // =============================================
  // RENDERERS
  // =============================================

  // --- Home Page ---
  function renderHome(app) {
    var html = "";

    // Hero
    html += '<section class="hero">';
    html += '<div class="hero-content fade-in">';
    html += "<h1>Every Woman Has a Starting Point</h1>";
    html +=
      '<p class="subtitle">This isn\u2019t a beauty blog. This is a feminine operating system.</p>';
    html +=
      "<p>You weren\u2019t given a manual. Most of us weren\u2019t. But the woman you\u2019re becoming needs a place to start \u2014 one area of focus that unlocks everything else.</p>";
    html +=
      '<a href="#/quiz/entry" class="btn btn-primary btn-lg">Find My Starting Point \u2192</a>';
    html += "</div>";
    html += "</section>";

    // Categories
    html += '<section class="categories-section">';
    html += '<div class="section-header">';
    html += '<span class="section-label">Explore</span>';
    html += "<h2>Four Pillars of Feminine Intelligence</h2>";
    html +=
      "<p>Each category contains modules, quizzes, and personalized recommendations designed for where you are right now.</p>";
    html += "</div>";
    html += '<div class="categories-grid">';

    var catKeys = ["hair", "skin", "feminine-care", "beauty-layer"];
    for (var i = 0; i < catKeys.length; i++) {
      var key = catKeys[i];
      var cat = CATEGORIES[key];
      html += '<div class="category-card" onclick="location.hash=\'#/category/' + key + '\'">';
      html += '<div class="cat-icon">' + cat.icon + "</div>";
      html += "<h3>" + cat.name + "</h3>";
      html += "<p>" + cat.desc + "</p>";
      html +=
        '<span class="module-count">' +
        cat.modules.length +
        " Modules</span>";
      html += "</div>";
    }

    html += "</div>";
    html += "</section>";

    // Philosophy section
    html += '<section class="section" style="background:var(--pink-pale)">';
    html += '<div class="section-header">';
    html += '<span class="section-label">The Philosophy</span>';
    html += "<h2>We Teach the Things No One Taught You</h2>";
    html += "</div>";
    html += '<div style="max-width:640px;margin:0 auto;padding:0 24px">';
    html += '<div class="content-cards">';
    var philosophyCards = [
      [
        "Hygiene Intelligence",
        "Not the basics you already know. The quiet details that separate \u201cclean\u201d from \u201cpolished.\u201d",
      ],
      [
        "Soft Luxury Habits",
        "Looking expensive isn\u2019t about money. It\u2019s about intention, consistency, and knowing the small things that signal care.",
      ],
      [
        "The Embarrassing Things",
        "Bloating. Digestion. Body odor. The things you Google at 2am. We talk about them here \u2014 softly, honestly, without shame.",
      ],
      [
        "Scent Identity",
        "How you smell is the most intimate layer of your presence. We teach you how to build a scent that\u2019s yours.",
      ],
    ];
    for (var j = 0; j < philosophyCards.length; j++) {
      html += '<div class="content-card">';
      html += "<h4>" + philosophyCards[j][0] + "</h4>";
      html += "<p>" + philosophyCards[j][1] + "</p>";
      html += "</div>";
    }
    html += "</div>";
    html += "</div>";
    html += "</section>";

    // CTA section
    html += '<section class="section">';
    html += '<div class="section-header">';
    html +=
      "<h2>Ready to Begin?</h2>";
    html += "<p>Take the quiz and discover your starting point. It takes 3 minutes and it will change how you see yourself.</p>";
    html +=
      '<a href="#/quiz/entry" class="btn btn-primary" style="margin-top:20px">Take the Quiz \u2192</a>';
    html += "</div>";
    html += "</section>";

    app.innerHTML = html;
  }

  // --- Category Page ---
  function renderCategory(app, catId) {
    var cat = CATEGORIES[catId];
    if (!cat) {
      renderHome(app);
      return;
    }

    var html = "";

    html += '<section class="category-hero">';
    html += '<span class="section-label">' + catId.replace("-", " ") + "</span>";
    html += "<h1>" + cat.name + "</h1>";
    html += '<p class="intro">' + cat.desc + "</p>";
    html += "</section>";

    html += '<section class="section">';
    html += '<div class="modules-grid">';

    for (var i = 0; i < cat.modules.length; i++) {
      var modId = cat.modules[i];
      var mod = MODULES[modId];
      if (!mod) continue;
      html +=
        '<div class="module-card" onclick="location.hash=\'#/module/' +
        modId +
        '\'">';
      html +=
        '<div class="mod-number">Module ' + (i + 1) + "</div>";
      html += "<h3>" + mod.title + "</h3>";
      html += "<p>" + mod.subtitle + "</p>";
      html += "</div>";
    }

    html += "</div>";
    html += "</section>";

    // Back link
    html += '<section class="section-sm" style="text-align:center">';
    html += '<a href="#/" class="back-link">Back to Home</a>';
    html += "</section>";

    app.innerHTML = html;
  }

  // --- Module Page ---
  function renderModule(app, modId) {
    var mod = MODULES[modId];
    if (!mod) {
      renderHome(app);
      return;
    }

    var catName = CATEGORIES[mod.category]
      ? CATEGORIES[mod.category].name
      : "";
    var html = "";

    // Hero
    html += '<section class="module-hero">';
    html +=
      '<a href="#/category/' +
      mod.category +
      '" class="back-link">' +
      catName +
      "</a>";
    html += '<span class="section-label">' + catName + "</span>";
    html += "<h1>" + mod.title + "</h1>";
    html += '<p class="intro">' + mod.intro + "</p>";
    html += "</section>";

    // Content Cards
    html += '<section class="section">';
    html += '<div class="content-cards">';
    for (var i = 0; i < mod.cards.length; i++) {
      html += '<div class="content-card">';
      html += "<h4>" + mod.cards[i][0] + "</h4>";
      html += "<p>" + mod.cards[i][1] + "</p>";
      html += "</div>";
    }
    html += "</div>";
    html += "</section>";

    // Divider
    html += '<div class="divider"></div>';

    // Quiz CTA
    html += '<section class="section-sm" style="text-align:center">';
    html += '<span class="section-label">Interactive Quiz</span>';
    html += "<h2>" + mod.quiz.title + "</h2>";
    html +=
      '<p style="color:var(--soft);font-family:var(--font-serif);font-style:italic;margin-bottom:24px">' +
      mod.quiz.subtitle +
      "</p>";
    html +=
      '<a href="#/quiz/' +
      modId +
      '" class="btn btn-primary">Start the Quiz \u2192</a>';
    html += "</section>";

    // MAPAON nudge for scent module
    if (mod.quiz.showMapaon) {
      html += '<section class="section-sm">';
      html += '<div class="product-nudge" style="max-width:560px;margin:0 auto">';
      html += "<h4>A scent worth knowing</h4>";
      html +=
        "<p>MAPAON Hair Perfume was designed for exactly this \u2014 a clean, lasting scent made specifically for your hair. Lightweight. No alcohol damage. Built to layer with your existing fragrance.</p>";
      html +=
        '<a href="https://mapaon.com" target="_blank" rel="noopener">Discover MAPAON \u2192</a>';
      html += "</div>";
      html += "</section>";
    }

    app.innerHTML = html;
  }

  // =============================================
  // QUIZ ENGINE
  // =============================================
  function renderEntryQuiz(app) {
    runQuiz(app, ENTRY_QUIZ, "entry");
  }

  function renderModuleQuiz(app, modId) {
    var mod = MODULES[modId];
    if (!mod) {
      renderHome(app);
      return;
    }
    runQuiz(app, mod.quiz, modId);
  }

  function runQuiz(app, quizData, quizId) {
    var currentQ = 0;
    var answers = [];
    var totalQ = quizData.questions.length;

    function renderQuestion() {
      var q = quizData.questions[currentQ];
      var html = "";

      html += '<section class="section">';
      html += '<div class="quiz-section">';

      // Progress
      html += '<div class="quiz-progress">';
      html +=
        '<div class="quiz-progress-bar" style="width:' +
        ((currentQ / totalQ) * 100).toFixed(0) +
        '%"></div>';
      html += "</div>";

      html +=
        '<div class="quiz-step-label">Question ' +
        (currentQ + 1) +
        " of " +
        totalQ +
        "</div>";
      html += '<div class="quiz-question">' + q.q + "</div>";

      html += '<div class="quiz-options">';
      for (var i = 0; i < q.opts.length; i++) {
        html +=
          '<button class="quiz-option" data-index="' +
          i +
          '">' +
          q.opts[i] +
          "</button>";
      }
      html += "</div>";

      html += "</div>";
      html += "</section>";

      app.innerHTML = html;

      // Attach event listeners
      var options = app.querySelectorAll(".quiz-option");
      for (var j = 0; j < options.length; j++) {
        options[j].addEventListener("click", function () {
          var idx = parseInt(this.getAttribute("data-index"));
          this.classList.add("selected");
          answers.push(idx);
          setTimeout(function () {
            currentQ++;
            if (currentQ < totalQ) {
              renderQuestion();
            } else {
              showProcessing();
            }
          }, 350);
        });
      }
    }

    function showProcessing() {
      var html = "";
      html += '<section class="section">';
      html += '<div class="quiz-processing">';
      html += "<p>Mapping your starting point\u2026</p>";
      html += "</div>";
      html += "</section>";
      app.innerHTML = html;

      setTimeout(function () {
        showResults();
      }, 2200);
    }

    function showResults() {
      // Score: count which answer index was selected most
      var mapLen = quizData.map.length;
      var scores = {};
      for (var m = 0; m < mapLen; m++) {
        scores[m] = 0;
      }

      for (var a = 0; a < answers.length; a++) {
        var ansIdx = answers[a];
        // Map answer index to result identity, wrapping if needed
        var mappedIdx = ansIdx < mapLen ? ansIdx : mapLen - 1;
        scores[mappedIdx]++;
      }

      // Find the highest score
      var maxScore = 0;
      var winner = 0;
      var tied = [];

      for (var s in scores) {
        if (scores[s] > maxScore) {
          maxScore = scores[s];
          winner = parseInt(s);
          tied = [parseInt(s)];
        } else if (scores[s] === maxScore) {
          tied.push(parseInt(s));
        }
      }

      // Tiebreaker
      if (tied.length > 1) {
        var tbIndex = quizData.tiebreaker || totalQ - 1;
        var tbAnswer = answers[tbIndex];
        winner = tbAnswer < mapLen ? tbAnswer : mapLen - 1;
      }

      var resultKey = quizData.map[winner];
      var result;

      if (quizId === "entry") {
        result = quizData.results[resultKey];
      } else {
        result = quizData.results[resultKey];
      }

      if (!result) {
        // Fallback to first result
        var firstKey = Object.keys(quizData.results)[0];
        result = quizData.results[firstKey];
        resultKey = firstKey;
      }

      var html = "";

      html += '<section class="section">';
      html += '<div class="result-section">';
      html += '<div class="result-label">Your Result</div>';
      html +=
        '<div class="result-name">' +
        (result.name || resultKey) +
        "</div>";
      html += '<div class="result-line">' + result.line + "</div>";

      if (result.body) {
        html += '<div class="result-body">';
        html += "<p>" + result.body + "</p>";
        html += "</div>";
      }

      if (result.shift) {
        html += '<div class="result-body">';
        html += "<h4>What to Shift</h4>";
        html += "<ul>";
        for (var si = 0; si < result.shift.length; si++) {
          html += "<li>" + result.shift[si] + "</li>";
        }
        html += "</ul>";
        html += "</div>";
      }

      if (result.start) {
        html += '<div class="result-body">';
        html += "<h4>What to Start</h4>";
        html += "<ul>";
        for (var st = 0; st < result.start.length; st++) {
          html += "<li>" + result.start[st] + "</li>";
        }
        html += "</ul>";
        html += "</div>";
      }

      // MAPAON nudge for scent module
      if (quizId === "hair-scent") {
        html += '<div class="product-nudge">';
        html += "<h4>A scent worth trying</h4>";
        html +=
          "<p>MAPAON Hair Perfume was designed for exactly this \u2014 a clean, lasting scent made specifically for your hair. Lightweight, no alcohol damage, and built to layer with your existing fragrance.</p>";
        html +=
          "<p><em>If you\u2019re starting your scent identity \u2014 this is a beautiful first step.</em></p>";
        html +=
          '<a href="https://mapaon.com" target="_blank" rel="noopener">Discover MAPAON \u2192</a>';
        html += "</div>";
      }

      // CTA
      if (result.path) {
        html +=
          '<a href="' +
          result.path +
          '" class="btn btn-primary" style="margin-top:32px">' +
          (result.cta || "Continue") +
          " \u2192</a>";
      } else if (quizId !== "entry") {
        html +=
          '<a href="#/module/' +
          quizId +
          '" class="btn btn-secondary" style="margin-top:32px">\u2190 Back to Module</a>';
      }

      html += "</div>";
      html += "</section>";

      // Email capture
      html += renderEmailCapture(quizId);

      app.innerHTML = html;

      // Attach email form handler
      var form = document.getElementById("emailForm");
      if (form) {
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          var input = document.getElementById("emailInput");
          var email = input.value.trim();
          if (email && email.indexOf("@") > -1) {
            var container = document.getElementById("emailCapture");
            container.innerHTML =
              '<div class="email-success"><p>Check your inbox. Your journey just started.</p></div>';
          }
        });
      }
    }

    renderQuestion();
  }

  // =============================================
  // EMAIL CAPTURE
  // =============================================
  function renderEmailCapture(quizId) {
    var headlines = {
      entry: "Your starting point is ready.",
      "hair-scent": "Your scent identity has been revealed.",
      "hair-clean-slate": "Your hair reset plan is ready.",
      "hair-no-heat": "Your heatless style guide is ready.",
      "hair-code": "Your hair routine level has been identified.",
      "skin-soft": "Your skin texture profile is ready.",
      "skin-shower": "Your shower awareness results are in.",
      "skin-timing": "Your moisture timing analysis is ready.",
      "care-flat-stomach": "Your bloat pattern has a name now.",
      "care-quiet-system": "Now you know your rhythm.",
      "care-eating": "Your eating identity has been revealed.",
      "beauty-less-makeup": "Your makeup relationship just got clarity.",
      "beauty-day-night": "Your face identity is ready.",
      "beauty-clean-canvas": "Your nighttime canvas score is in.",
    };

    var headline = headlines[quizId] || "Your results are ready.";

    var html = "";
    html += '<div class="email-capture" id="emailCapture">';
    html += "<h3>" + headline + "</h3>";
    html +=
      "<p>We built a personalized routine just for you. Enter your email and it\u2019s yours.</p>";
    html += '<form class="email-form" id="emailForm">';
    html +=
      '<input type="email" class="email-input" id="emailInput" placeholder="Your best email" required>';
    html +=
      '<button type="submit" class="btn btn-primary btn-sm">Send My Routine \u2192</button>';
    html += "</form>";
    html +=
      '<span class="email-micro">No spam. Just feminine intelligence, delivered softly.</span>';
    html += "</div>";

    return html;
  }

  // =============================================
  // NAV LOGIC
  // =============================================
  function initNav() {
    var toggle = document.getElementById("navToggle");
    var links = document.getElementById("navLinks");

    if (toggle && links) {
      toggle.addEventListener("click", function () {
        links.classList.toggle("open");
      });

      // Close mobile nav when a link is clicked
      var navAnchors = links.querySelectorAll("a");
      for (var i = 0; i < navAnchors.length; i++) {
        navAnchors[i].addEventListener("click", function () {
          links.classList.remove("open");
        });
      }
    }

    // Scroll shadow on nav
    window.addEventListener("scroll", function () {
      var nav = document.getElementById("nav");
      if (window.scrollY > 10) {
        nav.classList.add("scrolled");
      } else {
        nav.classList.remove("scrolled");
      }
    });
  }

  // =============================================
  // INIT
  // =============================================
  function init() {
    initNav();
    navigate();
  }

  window.addEventListener("hashchange", navigate);
  document.addEventListener("DOMContentLoaded", init);
})();
