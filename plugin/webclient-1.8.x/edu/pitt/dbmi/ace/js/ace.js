const PROCESS_STAGES = [
    {
        num: 1,
        name: "Intake & Literature Review",
        color: "amber",
        description: "Validate question, check existing evidence, assess SHRINE suitability",
        team: "ACE Clinician Team"
    },
    {
        num: 2,
        name: "Clinical Concept Extraction",
        color: "violet",
        description: "Extract diseases, medications, labs, demographics, temporal relationships",
        team: "ACE Clinician & Informatics"
    },
    {
        num: 3,
        name: "SHRINE Ontology Mapping",
        color: "emerald",
        description: "Map concepts to ICD-10, RxNorm, LOINC codes in SHRINE dictionary",
        team: "Informatics Analyst Team"
    },
    {
        num: 4,
        name: "Query Logic Builder",
        color: "violet",
        description: "Define inclusion/exclusion criteria with With, Without, When logic",
        team: "ACE Clinician & Informatics"
    },
    {
        num: 5,
        name: "Sharephe / i2b2 XML Compiler",
        color: "blue",
        description: "Compile reviewed query logic into validated i2b2 XML",
        team: "Informatics Analyst Team"
    }
];
const EXAMPLE_QUESTIONS = [
    'Is calf muscle injury associated with increased risk of deep vein thrombosis?',
    'Does hydroxychloroquine (HCQ) prevent Covid-19 as post-exposure prophylaxis (after exposure to the virus)?',
    'Does empagliflozin (Jardiance) have a lower limb amputation (LLA) rate compared to canagliflozin (Invokana), as previously reported? FDA had issued a Boxed Warning on increased risk of LLAs for canagliflozin in 2017 and removed the Boxed Warning in September 2020.'
];

// UI components
const inputQuestion = document.getElementById('input_question');
const startGenerationBtn = document.getElementById('start_gen_btn');
const stageProgress = document.getElementById('stage_progress');
const exampleQuestionBtns = [];

// application states
const stages = [];
let isRunning = false;
let pipelineMessage = null;

const getStageProgressIcon = function (status) {
    switch (status) {
        case 'pending':
            return `<div class="w-8 h-8 rounded-full border-2 border-gray-300 flex items-center justify-center">
    <div class="w-2 h-2 rounded-full bg-gray-300"></div>
</div>`;
        case 'running':
            return `<div class="relative w-8 h-8 flex items-center justify-center">
    <div class="absolute w-8 h-8 rounded-full border-2 border-amber-400 animate-pulse-ring"></div>
    <div class="w-4 h-4 rounded-full bg-amber-400 animate-pulse"></div>
</div>`;
        case 'complete':
            return `<div class="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center">
    <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
    </svg>
</div>`;
        case 'needs_review':
            return `<div class="w-8 h-8 rounded-full bg-amber-500 flex items-center justify-center">
    <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008v.008H12V16.5z" />
    </svg>
</div>`;
        default:
            return `<div class="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center">
    <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
</div>`;
    }
};

const createPipelineStageDivider = function () {
    return `<div class="flex justify-start ml-[15px] my-0.5">
        <div class="w-0.5 h-4 bg-gray-200"></div>
    </div>`;
};
const showPipelineStages = function () {
    const size = PROCESS_STAGES.length - 1;
    const htmlCodes = PROCESS_STAGES.map((stage, i) => {
        const state = stages.find((s) => s.stage === stage.num);
        const isActive = state?.status === "running";
        const isComplete = state?.status === "complete";
        const needsReview = state?.status === "needs_review";

        return `<div>
    <div class="flex items-start gap-3 p-3 rounded-xl ${isActive ? 'transition-all bg-gray-100' : 'transition-all'}">
        ${getStageProgressIcon(state?.status)}
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
                <span class="text-sm font-medium ${isComplete || isActive ? "text-gray-900" : needsReview ? "text-amber-800" : "text-gray-400"}">${stage.name}</span>
            </div>
            <p class="text-xs mt-0.5 ${isActive || isComplete ? "text-gray-600" : needsReview ? "text-amber-700" : "text-gray-400"}">${stage.description}</p>
        </div>
    </div>
    ${(i === size) ? '' : createPipelineStageDivider()}
</div>`;
    });

    stageProgress.innerHTML = htmlCodes.join('\n');
};

const runPipeline = () => {
    const question = inputQuestion.value;
    if (isRunning || !question) {
        return;
    }

    setStartGenerationButtonStatusProccessing(true);
    setIsRunning(true);

    stages.push(...PROCESS_STAGES.map((s) => ({stage: s.num, agent: s.name, status: "pending"})));
    showPipelineStages();


    const successHandler = function (response) {
        setTimeout(function () {
            console.info(response);
        }, 500);
    };
    const errorHandler = function (err) {
        console.error(err);
    };
//    i2b2.ace.api.step1(question, successHandler, errorHandler);
};

const setIsRunning = (value) => {
    isRunning = value;

    startGenerationBtn.disabled = isRunning;
    inputQuestion.disabled = isRunning;
    for (const btn of exampleQuestionBtns) {
        btn.disabled = isRunning;
    }
};

const addExampleQuestions = () => {
    const div = document.getElementById('examples');

    const span = document.createElement('span');
    span.className = 'text-sm text-gray-600';
    span.textContent = 'Examples:';
    div.appendChild(span);

    exampleQuestionBtns.length = 0;
    for (const question of EXAMPLE_QUESTIONS) {
        const button = document.createElement('button');
        button.className = 'example-question-btn';
        button.textContent = question;
        button.onclick = () => {
            stages.length = 0;
            pipelineMessage = null;
            inputQuestion.value = question;
            startGenerationBtn.disabled = isRunning;
        };

        exampleQuestionBtns.push(button);

        div.appendChild(button);
    }
};

const setStartGenerationButtonStatusProccessing = function (isProcessing) {
    if (isProcessing) {
        startGenerationBtn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
</svg> Processing...
`;
    } else {
        startGenerationBtn.innerHTML = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
        </svg> Start Automated Clinical Evidence Generation
`;
    }
};

const addTabEventListeners = () => {
    const tabs = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // 1. reset all tabs to inactive state
            tabs.forEach(t => {
                t.setAttribute('aria-selected', 'false');
                t.classList.remove('border-blue-600', 'text-blue-600');
                t.classList.add('border-transparent', 'text-gray-500');
            });

            // 2. hide all content panels
            panels.forEach(p => p.classList.add('hidden'));

            // 3. set chosen tab to active
            tab.setAttribute('aria-selected', 'true');
            tab.classList.add('border-blue-600', 'text-blue-600');
            tab.classList.remove('border-transparent', 'text-gray-500');

            // 4. reveal targeted panel
            const targetId = tab.getAttribute('data-target');
            document.getElementById(targetId).classList.remove('hidden');
        });
    });
};
const addEventListeners = () => {
    addTabEventListeners();

    inputQuestion.addEventListener('input', (event) => {
        startGenerationBtn.disabled = isRunning || !event.target.value;
    });

    startGenerationBtn.addEventListener('click', runPipeline);
};
const init = () => {
    addExampleQuestions();
    addEventListeners();

    // set textarea question
    inputQuestion.value = '';
    setStartGenerationButtonStatusProccessing(false);
    startGenerationBtn.disabled = true;
};