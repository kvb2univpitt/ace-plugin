"use client";

import type { Step5XmlArtifact } from "@/lib/common/query-plan-types";


function parseXMLFromString(xmlString: string): Document | null {
    if (typeof window === 'undefined') {
        console.warn('DOMParser is only available in the browser.');
        return null;
    }

    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

        // Check for parsing errors hidden inside the returned document
        const parserError = xmlDoc.getElementsByTagName('parsererror');
        if (parserError.length > 0) {
            throw new Error(parserError[0].textContent || 'Unknown XML parsing error');
        }

        return xmlDoc;
    } catch (error) {
        console.error('Failed to parse XML:', error);
        return null;
    }
}

export async function fakeRunQueryXml(artifacts: Step5XmlArtifact[]): Promise<Map<string, number>> {
    const patientCounts: Map<string, number> = new Map();

    for (const artifact of artifacts) {
        const queryId: string = artifact.queryId;
        switch (queryId) {
            case 'query-calf-injury-with-dvt':
                // r1c1
                patientCounts.set(artifact.queryId, 7194);
                break;
            case 'query-calf-injury-denominator':
                // r1c2
                patientCounts.set(artifact.queryId, 97952);
                break;
            case 'query-no-calf-injury-with-dvt':
                // r2c1
                patientCounts.set(artifact.queryId, 8195);
                break;
            case 'query-no-calf-injury-denominator':
                // r2c2
                patientCounts.set(artifact.queryId, 103648);
                break;
        }
    }

    return patientCounts;
}

export async function runQueryXml(artifacts: Step5XmlArtifact[]): Promise<Map<string, number>> {
    const patientCounts: Map<string, number> = new Map();

    // verify that the i2b2 framework is loaded in the global window
    if (typeof window === 'undefined' || !(window as any).i2b2) {
        console.warn('DOMParser is only available in the browser.');
        return patientCounts;
    }

    const i2b2 = (window as any).i2b2;

    for (const artifact of artifacts) {
        const queryDef: string | null = artifact.xml;
        if (queryDef) {
            const params = {
                result_wait_time: 180,
                psm_query_definition: queryDef,
                psm_result_output: '<result_output_list><result_output priority_index="9" name="patient_count_xml"/></result_output_list>',
                shrine_topic: '',
                query_run_method: ''
            };
            try {
                const data: string = await i2b2.ajax.CRC.runQueryInstance_fromQueryDefinition(params);
                const xmlDoc = parseXMLFromString(data);
                if (xmlDoc) {
                    const queryResultInstance = xmlDoc.getElementsByTagName('query_result_instance')[0];
                    const statusTypeId = queryResultInstance.querySelector('status_type_id');
                    if (statusTypeId) {
                        const status: number = parseInt(statusTypeId.textContent.trim());
                        if (status === 3) {
                            const setSize = queryResultInstance.querySelector('set_size');
                            if (setSize) {
                                patientCounts.set(artifact.queryId, parseInt(setSize.textContent.trim()));
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Failed to run query XML:', error);
            }
        }
    }

    try {
        setTimeout(i2b2.authorizedTunnel.function["i2b2.CRC.view.history.doRefreshAll"], 250);
    } catch (error) {
        console.error("Failed to securely communicate with i2b2 framework:", error);
    }

    return patientCounts;
}