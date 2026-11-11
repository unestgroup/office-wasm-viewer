Module.noInitialRun = true;
Module.noExitRuntime = true;
// Thread pool size for the multi-threaded build (-sPTHREAD_POOL_SIZE=x2tPoolSize); unused in the single-threaded one.
var x2tPoolSize = Module['pthreadPoolSize'] | 0;
(function() {
	let suffix;
	if (typeof document != 'undefined') {
		const myScript = document.currentScript;
		const mySrc = myScript.getAttribute('src');
		suffix = new URL(mySrc).search;
	} else {
		suffix = '';
	}

	Module.locateFile = function(path, prefix) {
		return prefix + path + suffix;
	};
})();
