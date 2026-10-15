const parser = new DOMParser();
const serializer = new XMLSerializer();

const loadDataFromFile = async () => {
    try {
        const response = await fetch('./step5_compiled.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error("Could not read or parse the JSON file:", error);
    }
};

const getQueryName = (xmlDoc) => {
    return xmlDoc.querySelector('query_name').textContent;
};
const getQueryXMLs = async () => {
    const queryXMLs = [];
    const step5Data = await loadDataFromFile();
    for (const artifact of step5Data.data.artifacts) {
        queryXMLs.push(parser.parseFromString(artifact.xml, "text/xml"));
    }

    return queryXMLs;
};

const runQueryXML = (queryXML) => {
    let queryDef = '<query_definition>';
    if (queryXML.getElementsByTagName('query_definition').length > 0) {
        queryDef += queryXML.getElementsByTagName('query_definition')[0].innerHTML;
    } else if (queryXML.getElementsByTagName('ns3:query_definition').length > 0) {
        queryDef += queryXML.getElementsByTagName('ns3:query_definition')[0].innerHTML;
    } else if (queryXML.getElementsByTagName('ns4:query_definition').length > 0) {
        queryDef += queryXML.getElementsByTagName('ns4:query_definition')[0].innerHTML;
    } else if (queryXML.getElementsByTagName('ns5:query_definition').length > 0) {
        queryDef += queryXML.getElementsByTagName('ns5:query_definition')[0].innerHTML;
    }
    queryDef += '</query_definition>';

    const params = {
        result_wait_time: 180,
        psm_query_definition: queryDef,
        psm_result_output: '<result_output_list><result_output priority_index="9" name="patient_count_xml"/></result_output_list>',
        shrine_topic: '',
        query_run_method: ''
    };

    i2b2.ajax.CRC.runQueryInstance_fromQueryDefinition(params).then(data => {
        const xmlDoc = parser.parseFromString(data, "text/xml");
        const queryResultInstance = xmlDoc.getElementsByTagName('query_result_instance')[0];
        const statusType_id = parseInt(queryResultInstance.querySelector('status_type_id').textContent.trim());

        setTimeout(i2b2.authorizedTunnel.function["i2b2.CRC.view.history.doRefreshAll"], 500);
        setTimeout(function () {
            if (statusType_id === 3) {
                const numOfPatients = parseInt(queryResultInstance.querySelector('set_size').textContent.trim());
                console.info(numOfPatients);
            }
        });
    });
};

const step5Btn = document.getElementById('step5_btn');
step5Btn.addEventListener("click", async () => {
    const queryXMLs = await getQueryXMLs();
    for (const queryXML of queryXMLs) {
        runQueryXML(queryXML);
    }
});