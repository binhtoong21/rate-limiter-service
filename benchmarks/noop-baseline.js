import http from "k6/http";
import { check } from "k6";

var BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export var options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '2m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  var res = http.get(BASE_URL + "/bench/noop");

  check(res, {
    "is status 200": function(r) { return r.status === 200; },
  });
}
