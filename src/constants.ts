interface IConstants {
	// Matrix-specific constants
	sessionPath: string;
	// Matrix room types we want to ignore (if any)
	ignoredRoomTypes: string[];
}

const constants: IConstants = {
	sessionPath: "./",
	ignoredRoomTypes: [] // Add any Matrix room types to ignore
};

export default constants;
