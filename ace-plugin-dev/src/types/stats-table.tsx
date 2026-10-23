export interface CellData {
    id: string;
    counts: number;
    description: string;
};

export interface TableData {
    r1c1: CellData;
    r1c2: CellData;
    r2c1: CellData;
    r2c2: CellData;
};

export interface TableCounts {
    exposed: {
        positive: number,
        negative: number,
        total: number
    };
    unexposed: {
        positive: number,
        negative: number,
        total: number
    }
};

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