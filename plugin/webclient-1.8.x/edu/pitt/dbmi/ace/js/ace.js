const EXAMPLE_QUESTIONS = [
    'Is calf muscle injury associated with increased risk of deep vein thrombosis?',
    'Does hydroxychloroquine (HCQ) prevent Covid-19 as post-exposure prophylaxis (after exposure to the virus)?',
    'Does empagliflozin (Jardiance) have a lower limb amputation (LLA) rate compared to canagliflozin (Invokana), as previously reported? FDA had issued a Boxed Warning on increased risk of LLAs for canagliflozin in 2017 and removed the Boxed Warning in September 2020.'
];
const inputQuestion = document.getElementById('input_question');

const stages = [];

let isRunning = false;
let pipelineMessage = null;

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
};

const addExamples = () => {
    const div = document.getElementById('examples');

    const span = document.createElement('span');
    span.className = 'text-sm text-gray-600';
    span.textContent = 'Examples:';
    div.appendChild(span);

    for (const question of EXAMPLE_QUESTIONS) {
        const button = document.createElement("button");
        button.className = 'text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 hover:text-gray-900 transition-colors border border-gray-200 max-w-[200px] truncate';
        button.textContent = question;
        button.onclick = () => {
            stages.length = 0;
            pipelineMessage = null;
            inputQuestion.value = question;
        };

        div.appendChild(button);
    }
};
const init = () => {
    addEventListeners();
    addExamples();

    // set textarea question
    inputQuestion.value = '';
    inputQuestion.disabled = isRunning;
};