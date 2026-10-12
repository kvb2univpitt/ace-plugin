STAGES = [
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
EXAMPLE_QUESTIONS = [
    'Is calf muscle injury associated with increased risk of deep vein thrombosis?',
    'Does hydroxychloroquine (HCQ) prevent Covid-19 as post-exposure prophylaxis (after exposure to the virus)?',
    'Does empagliflozin (Jardiance) have a lower limb amputation (LLA) rate compared to canagliflozin (Invokana), as previously reported? FDA had issued a Boxed Warning on increased risk of LLAs for canagliflozin in 2017 and removed the Boxed Warning in September 2020.'
];

// UI components
const inputQuestion = document.getElementById('input_question');
const startGenerationBtn = document.getElementById('start_gen_btn');
const exampleQuestionBtns = [];

// application states
const stages = [];
let isRunning = false;
let pipelineMessage = null;

const runPipeline = () => {
    const question = inputQuestion.value;
    if (isRunning || !question) {
        return;
    }

    setIsRunning(true);

    const successHandler = function (response) {
        setTimeout(function () {
            console.info(response);
        }, 500);
    };
    const errorHandler = function (err) {
        console.error(err);
    };
    i2b2.ace.api.step1(question, successHandler, errorHandler);
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
    startGenerationBtn.disabled = true;
};