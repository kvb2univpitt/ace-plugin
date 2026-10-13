if (typeof i2b2.ace === 'undefined') {
    i2b2.ace = {};
}

i2b2.ace.api = {};
i2b2.ace.api.url = 'http://localhost:3000';

i2b2.ace.api.step1 = function (question, successHandler, errorHandler) {
    $.ajax({
        type: 'POST', // For jQuery < 1.9
        method: 'POST',
        crossDomain: true,
        cache: false,
        dataType: 'json',
        contentType: 'application/json',
        url: i2b2.ace.api.url + '/api/step1',
        data: JSON.stringify({
            clinicalQuestion: question
        }),
        success: successHandler,
        error: errorHandler
    });
};