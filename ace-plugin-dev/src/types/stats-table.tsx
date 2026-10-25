export interface IncidenceRateRatio {
    exposedTotalPer100: number,
    unexposedTotalPer100: number,
    irr: number,
    lnIrr: number,
    varLnIrr: number,
    lnStdErr: number,
    ci: number,
    lower95CI: number,
    upper95CI: number,
    zScore: number,
    pValue: number
}

export interface CountData {
    r1c1: {
        id: string;
        name: string;
        counts: number;
    };
    r1c2: {
        id: string;
        name: string;
        counts: number;
    };
    r2c1: {
        id: string;
        name: string;
        counts: number;
    };
    r2c2: {
        id: string;
        name: string;
        counts: number;
    };
}